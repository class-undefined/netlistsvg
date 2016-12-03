'use strict';

var fs = require('fs-extra'),
    onml = require('onml'),
    _ = require('lodash'),
    klay = require('klayjs'),
    clone = require('clone');

fs.readFile('test.svg', 'utf-8', skin_read);

function skin_read(err, data) {
	if (err) throw err;
	var skin = onml.p(data);
	fs.readJson('test.json', function (err, yosys_netlist) {
		if (err) throw err;
		var module_name = Object.keys(yosys_netlist.modules)[0];
		console.log(module_name);
		var module = getReformattedModule(yosys_netlist.modules[module_name]);
		addConstants(module);
		addSplitsJoins(module);
		createWires(module);
		var kgraph = buildKGraph(module, module_name, skin);
		fs.writeJson('in.json', kgraph);
		klay.layout({
			graph: kgraph,
			options: { spacing: 20, borderSpacing: 50, nodeLayering: 'LONGEST_PATH' },
			success: function(g) { klayed_out(g, module, skin)},
			error: function(error) { console.log(error); }
   		});

    });
}

function klayed_out(g, module, skin_data) {
	fs.writeJson('out.json', g);
	var nodes = _.map(module.nodes, function(n){
		var kchild = _.find(g.children,function(c) {
			return c.id == n.key;
		});
		var template = findSkinType(skin_data, n.type);
		var tempclone = clone(template);
		tempclone[1].transform = 'translate(' + kchild.x+','+kchild.y+')';
		if (n.type == '$_constant_' ||
			n.type == '$_inputExt_' ||
			n.type == '$_outputExt_') {
			tempclone[2][2] = n.key;
		}
		else if (n.type == '$_split_')
		{
			tempclone[2][1].height = Number(getGenericHeight(template, n));
			var outPorts = getPortsWithPrefix(template, 'out');
			var gap = Number(outPorts[1][1]['s:y']) - Number(outPorts[0][1]['s:y']);
			var startY = Number(outPorts[0][1]['s:y']);
			tempclone.pop();
			tempclone.pop();
			_.forEach(n.outputPorts,function(p, i)
			{
				var portClone = clone(outPorts[0]);
				portClone[portClone.length-1][2] = p.key;
				portClone[1].transform = 'translate('+outPorts[1][1]['s:x'] + ','
				                                    + (startY + i*gap) + ')';
				tempclone.push(portClone);
			});
		}
		else if (n.type == '$_join_')
		{
			tempclone[2][1].height = Number(getGenericHeight(template, n));
			var inPorts = getPortsWithPrefix(template, 'in');
			var gap = Number(inPorts[1][1]['s:y']) - Number(inPorts[0][1]['s:y']);
			var startY = Number(inPorts[0][1]['s:y']);
			tempclone.pop();
			tempclone.pop();
			_.forEach(n.inputPorts,function(p, i)
			{
				var portClone = clone(inPorts[0]);
				portClone[portClone.length-1][2] = p.key;
				portClone[1].transform = 'translate('+inPorts[1][1]['s:x'] + ','
				                                    + (startY + i*gap) + ')';
				tempclone.push(portClone);
			});
		}
		else if (template[1]['s:type'] == 'generic')
		{
			tempclone[2][1].height = Number(getGenericHeight(template, n));
			var inPorts = getPortsWithPrefix(template, 'in');
			var ingap = Number(inPorts[1][1]['s:y']) - Number(inPorts[0][1]['s:y']);
			var instartY = Number(inPorts[0][1]['s:y']);
			var outPorts = getPortsWithPrefix(template, 'out');
			var outgap = Number(outPorts[1][1]['s:y']) - Number(outPorts[0][1]['s:y']);
			var outstartY = Number(outPorts[0][1]['s:y']);
			tempclone.pop();
			tempclone.pop();
			tempclone.pop();
			tempclone.pop();
			_.forEach(n.inputPorts,function(p, i)
			{
				var portClone = clone(inPorts[0]);
				portClone[portClone.length-1][2] = p.key;
				portClone[1].transform = 'translate('+inPorts[1][1]['s:x'] + ','
				                                    + (instartY + i*ingap) + ')';
				tempclone.push(portClone);
			});
			_.forEach(n.outputPorts,function(p, i)
			{
				var portClone = clone(outPorts[0]);
				portClone[portClone.length-1][2] = p.key;
				portClone[1].transform = 'translate('+outPorts[1][1]['s:x'] + ','
				                                    + (outstartY + i*outgap) + ')';
				tempclone.push(portClone);
			});
			tempclone[2][2] = n.type;
		}
		return tempclone;
	});
	var lines = _.flatMap(g.edges, function (e) {
		var startPoint = e.sourcePoint;
		var bends = _.map(e.bendPoints, function (b)
		{
			var l = ['line', {'x1':startPoint.x,
		                     'y1':startPoint.y,
		                     'x2':b.x,
		                      'y2':b.y}];
		    startPoint = b;
		    return l;
		});
		bends = bends.concat(_.map(e.junctionPoints, function (j)
		{
			return ['circle', {'cx':j.x, 'cy':j.y, 'r':2, 'style':"fill:#000"}];
		}));
		return bends.concat([['line',{'x1':startPoint.x,
		                     'y1':startPoint.y,
		                     'x2':e.targetPoint.x,
		                     'y2':e.targetPoint.y}]]);
	});
	var svg = skin_data.slice(0,2);
	console.log(svg);
    var ret = svg.concat(nodes).concat(lines);
	fs.writeFile('out.svg', onml.s(ret), 'utf-8', function(e) { console.log(e);});
}


function buildKGraph(module, module_name, skin_data)
{
	var children = _.map(module.nodes,function(n)
	{
		return buildKGraphChild(skin_data, n);
	});
	var i =0;
    var edges = _.flatMap(module.wires,function(w) {
        var sourceParentKey = w.drivers[0].parentNode.key;
        var sourceKey = sourceParentKey + '.' + w.drivers[0].key;
        return _.map(w.riders, function (r) {
            var targetParentKey = r.parentNode.key;
            var targetKey = targetParentKey + '.' + r.key;
            var edge = {
                id: 'e' + i,
                source: sourceParentKey,
                sourcePort: sourceKey,
                target: targetParentKey,
                targetPort: targetKey
            };
            if (w.drivers[0].parentNode.type != '$dff') {
                edge.properties = {"de.cau.cs.kieler.priority":1}
            }
            i += 1;
            return edge;
        });
    });
    return {id:module_name,
    	    children:children,
    	    edges:edges,
    	    };
}

function getGenericHeight(template, node)
{
	var inPorts = getPortsWithPrefix(template, 'in');
	var outPorts = getPortsWithPrefix(template, 'out');
	if (node.inputPorts.length > node.outputPorts.length) {
		var gap = Number(inPorts[1][1]['s:y']) - Number(inPorts[0][1]['s:y']);
		return Number(template[1]['s:height']) + gap * (node.inputPorts.length - 2);
	}
	var gap = Number(outPorts[1][1]['s:y']) - Number(outPorts[0][1]['s:y']);
	return Number(template[1]['s:height']) + gap * (node.outputPorts.length - 2);
}

function getPortsWithPrefix(n, prefix)
{
	var ports = _.filter(n, function (e) {
		if (e instanceof Array && e[0] == 'g') {
			return e[1]['s:pid'].startsWith(prefix);
		}
	});
	return ports;
}

function getGenericPortsFrom(nports, templatePorts, nkey)
{
	return _.map(nports, function (p, i)
	{
		if (i == 0) {
			return {
				id : nkey + '.' + p.key,
				width : 1,
				height : 1,
				x : Number(templatePorts[0][1]['s:x']),
				y : Number(templatePorts[0][1]['s:y'])
			};
		} else {
			var gap = Number(templatePorts[1][1]['s:y']) - Number(templatePorts[0][1]['s:y']);
			return {
				id : nkey + '.' + p.key,
				width : 1,
				height : 1,
				x : Number(templatePorts[0][1]['s:x']),
				y : (i) * gap + Number(templatePorts[0][1]['s:y'])
			};
		}
	})
}

//given a module type, build kgraphchild
function buildKGraphChild(skin_data, n)
{
	var template = findSkinType(skin_data, n.type);
	var type = template[1]['s:type'];
	if (type == 'join' ||
		type == 'split' ||
		type == 'generic')
	{
		var inPorts = getPortsWithPrefix(template, 'in');
		var outPorts = getPortsWithPrefix(template, 'out');
		var ports = getGenericPortsFrom(n.inputPorts,
										inPorts,
										n.key).concat(
					getGenericPortsFrom(n.outputPorts,
						                outPorts,
						                n.key));
		return {
			id: n.key,
			width: Number(template[1]['s:width']),
			height: Number(getGenericHeight(template, n)),
			ports: ports,
			properties: {"de.cau.cs.kieler.portConstraints": "FIXED_POS"}
		};
	}
	var ports = _.map(getPortsWithPrefix(template, ''), function(p)
	{
		return {
			id : n.key + '.' + p[1]['s:pid'],
			width : 1,
			height : 1,
			x : Number(p[1]['s:x']),
			y : Number(p[1]['s:y'])
		};
	});
	return {
		id: n.key,
		width: Number(template[1]['s:width']),
		height: Number(template[1]['s:height']),
		ports: ports,
		properties: {"de.cau.cs.kieler.portConstraints": "FIXED_POS"}
	};
}

function findSkinType(skin_data, type)
{
	var ret = null;
	onml.traverse(skin_data, {
    enter: function (node, parent) {
        if (node.name == 's:alias' && node.attr.val == type)
        {
        	ret = parent;
        }
    }});
    if (ret == null) {
    	onml.traverse(skin_data, {
    	enter: function (node, parent) {
        	if (node.attr['s:type'] == 'generic')
        	{
        		ret = node;
        	}
    	}});
    }
    console.log(ret);
    return ret.full;
}

function toArray(assoc)
{
	return _.flatMap(assoc, function(val, key) {
		val.key = key;
		return val;
	});
}

// returns an array of ports that are going a specific direction
// the elements in this array are obects whose members are key and value
// where key is the port name and value is the connection array
function getCellPortList(cell, direction)
{
	var ports = _.filter(_.flatMap(cell.connections, function(val, key) {
		return {key:key, value:val};
	}), function(val) {
		return cell.port_directions[val.key] == direction;
	});
	return ports;
}

// returns a reformatted module
function getReformattedModule(module)
{
    var ports= toArray(module.ports);

    var flatModule =
    {
        'inputPorts' : _.filter(ports, function(p){return p.direction=='input'}),
        'outputPorts': _.filter(ports, function(p){return p.direction=='output'}),
        'cells':toArray(module.cells)
    };
    flatModule.inputPorts.forEach(function(p){p.type="$_inputExt_";});
    flatModule.outputPorts.forEach(function(p){p.type="$_outputExt_";});
    flatModule.cells.forEach(function(c)
    {
        c.inputPorts = getCellPortList(c,"input");
        c.outputPorts = getCellPortList(c,"output");
    });
    flatModule.inputPorts.forEach(function(p)
    {
        p.inputPorts = [];
        p.outputPorts = [{'key':'Y','value':p.bits}];
    });
    flatModule.outputPorts.forEach(function(p)
    {
        p.inputPorts = [{'key':'A','value':p.bits}];
        p.outputPorts = [];
    });
    flatModule.nodes = flatModule.inputPorts
                        .concat(flatModule.outputPorts)
                        .concat(flatModule.cells);
    return flatModule;
}

// converts input ports with constant assignments to constant nodes
function addConstants(module)
{
    // find the maximum signal number
    var maxNum=-1;
    module.nodes.forEach(function(n)
    {
        n.outputPorts.forEach(function(p) {
        	maxNum = _.max([maxNum, _.max(p.value)])
        });
    });


    // add constants to cells
    module.nodes.forEach(function(n)
    {
        n.inputPorts.forEach(function(p)
        {
            var name = "";
            var constants = [];
            var lastNode = null;
            for (var i in p.value) {
                if (p.value[i]<2)
                {
                    maxNum += 1;
                    name+=p.value[i];
                    p.value[i] = maxNum;
                    constants.push(maxNum);
                    lastNode = n;
                }
                else if (constants.length>0)
                {
                    var constant = {
                        "key": name.split('').reverse().join(''),
                        "hide_name": 1,
                        "type": '$_constant_',
                        "inputPorts":[],
                        "outputPorts":[{'key':'Y','value':constants}]
                    }
                    if (n.attributes.src) {
                      constant.attributes ={'src':n.attributes.src};
                    }
                    module.cells.push(constant);
                    name='';
                    constants = [];
                }
            }
            if (constants.length>0)
            {
                var constant = {
                    "key": name.split('').reverse().join(''),
                    "hide_name": 1,
                    "type": '$_constant_',
                    "inputPorts":[],
                    "outputPorts":[{'key':'Y','value':constants}]
                }
                if (lastNode.attributes.src) {
                    constant.attributes ={'src':lastNode.attributes.src};
                }
                module.cells.push(constant);
            }
        });
    });
    module.nodes = module.inputPorts
                        .concat(module.outputPorts)
                        .concat(module.cells);
}

// solves for minimal bus splits and joins and adds them to module
function addSplitsJoins(module)
{
    var allInputs = [];
    var allOutputs = [];
    module.nodes.forEach(function(n)
    {
        n.inputPorts.forEach(function(i)
        {
            allInputs.push(','+i.value.join()+',');
        });
        n.outputPorts.forEach(function(i)
        {
            allOutputs.push(','+i.value.join()+',');
        });
    });

    var allInputsCopy = allInputs.slice();
    var splits = {};
    var joins = {};
    for (var i in allInputs) {
        gather(allOutputs, allInputsCopy, allInputs[i], 0, allInputs[i].length, splits, joins);
    }

    for (var join in joins) {
        var signals = join.slice(1,-1).split(',');
        for (var i in signals) {
          signals[i] = Number(signals[i])
        }
        var outPorts = [{'key':'Y','value':signals}];
        var inPorts = [];
        for (var i in joins[join]) {
            var name = joins[join][i];
            var value = getBits(signals, name);
          inPorts.push({'key':name,'value':value});
        }
        module.cells.push({"key":'$join$'+join,
          "hide_name": 1,
          "type": "$_join_",
          "inputPorts":inPorts,
          "outputPorts":outPorts});
    }

    for (var split in splits) {
        signals = split.slice(1,-1).split(',');
        for (var i in signals) {
          signals[i] = Number(signals[i])
        }
        var inPorts = [{'key':'A','value':signals}];
        var outPorts = [];
        for (var i in splits[split]) {
            var name = splits[split][i];
            var value = getBits(signals, name);
          outPorts.push({'key':name,'value':value});
        }
        module.cells.push({"key":'$split$'+split,
          "hide_name": 1,
          "type": "$_split_",
          "inputPorts":inPorts,
          "outputPorts":outPorts});
    }
    //refresh nodes
    module.nodes = module.inputPorts
                    .concat(module.outputPorts)
                    .concat(module.cells);
}

// returns a string that represents the values of the array of integers
function arrayToBitstring(bitArray) {
  var ret = ""
  for (var i in bitArray) {
    var bit = bitArray[i]
    if (ret=="") {
      ret = bit
    } else {
      ret += ','+bit
    }
  }
  return ','+ret+','
}

// returns whether needle is a substring of arrhaystack
function arrayContains(needle, haystack)
{
    return (haystack.indexOf(needle) > -1);
}

// returns the index of the string that contains a substring
// given arrhaystack, an array of strings
function indexOfContains(needle, arrhaystack)
{
  for (var i in arrhaystack) {
    if (arrayContains(needle, arrhaystack[i])) {
      return i
    }
  }
  return -1
}

function getBits(signals, indicesString) {
  var index = indicesString.indexOf(':')
  if (index==-1) {
    return [signals[indicesString]]
  } else {
    var start = indicesString.slice(0,index)
    var end = indicesString.slice(index+1)
    var slice = signals.slice(Number(start),Number(end)+1)
    return slice
  }
}

function addToDefaultDict(dict, key, value) {
  if (dict[key]==undefined) {
    dict[key]=[value]
  } else {
    dict[key].push(value)
  }
}

function getIndicesString(bitstring, query) {
  var splitStart = bitstring.indexOf(query)
  var splitEnd = splitStart + query.length
  var startIndex = bitstring.substring(0,splitStart).split(',').length-1;
  var endIndex = startIndex + query.split(',').length-3;

  if (startIndex == endIndex) {
    return startIndex+""
  } else {
    return startIndex+":"+endIndex
  }
}

function gather(inputs,
                outputs,
                toSolve, // element of outputs we are trying to solve
                start, // index of toSolve to start from
                end, //index of toSolve to end at
                splits,
                joins) {
  // remove myself from outputs list
  var index = outputs.indexOf(toSolve)
  if (arrayContains(toSolve, outputs)) {
    outputs.splice(index, 1);
  }

  // This toSolve is complete
  if (start >= toSolve.length || end - start < 2) {
    return
  }

  var query = toSolve.slice(start, end);

  // are there are perfect matches?
  if (arrayContains(query, inputs)) {
    if (query != toSolve) {

      addToDefaultDict(joins, toSolve, getIndicesString(toSolve,query))
    }
    gather(inputs, outputs, toSolve, end-1, toSolve.length, splits, joins)
    return
  }
  var index = indexOfContains(query, inputs);
  // are there any partial matches?
  if (index != -1) {
    if (query != toSolve) {
      addToDefaultDict(joins, toSolve, getIndicesString(toSolve,query))
    }
    // found a split
    addToDefaultDict(splits, inputs[index], getIndicesString(inputs[index],query))
    // we can match to this now
    inputs.push(query)
    gather(inputs, outputs, toSolve, end-1, toSolve.length, splits, joins)
    return
  }
  // are there any output matches?
  if (indexOfContains(query, outputs) != -1) {
    if (query != toSolve) {
      //add to join
      addToDefaultDict(joins, toSolve, getIndicesString(toSolve,query))
    }
    // gather without outputs

    gather(inputs, [], query, 0, query.length, splits, joins)
    inputs.push(query)
    return
  }

  gather(inputs, outputs, toSolve, start, start+ query.slice(0,-1).lastIndexOf(',')+1, splits, joins)
}

function createWires(module)
{
    var nets= {}
    module.nodes.forEach(function(n)
    {
        var nodeName = n.key;
        for (var i in n.inputPorts)
        {
            var port = n.inputPorts[i];
            port.parentNode = n;
            addToDefaultDict(nets,arrayToBitstring(port.value),port);
        }
    });
    var wires = [];
    module.nodes.forEach(function(n)
    {
        var nodeName = n.key;
        for (var i in n.outputPorts)
        {
            var port = n.outputPorts[i];
            port.parentNode = n;
            var riders = nets[arrayToBitstring(port.value)];
            var wire = {'drivers': [port], 'riders': riders};
            wires.push(wire);
            port.wire = wire;
            riders.forEach(function(r)
            {
                r.wire = wire;
            });
        }
    });
    module.wires = wires;
}