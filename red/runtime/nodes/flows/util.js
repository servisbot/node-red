/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/
var clone = require("clone");
var redUtil = require("../../util");
var subflowInstanceRE = /^subflow:(.+)$/;
var typeRegistry = require("../registry");

function diffNodes(oldNode,newNode) {
    if (oldNode == null) {
        return true;
    }
    var oldKeys = Object.keys(oldNode).filter(function(p) { return p != "x" && p != "y" && p != "wires" });
    var newKeys = Object.keys(newNode).filter(function(p) { return p != "x" && p != "y" && p != "wires" });
    if (oldKeys.length != newKeys.length) {
        return true;
    }
    for (var i=0;i<newKeys.length;i++) {
        var p = newKeys[i];
        if (!redUtil.compareObjects(oldNode[p],newNode[p])) {
            return true;
        }
    }

    return false;
}

var EnvVarPropertyRE = /^\$\((\S+)\)$/;

function mapEnvVarProperties(obj,prop) {
    if (Buffer.isBuffer(obj[prop])) {
        return;
    } else if (Array.isArray(obj[prop])) {
        for (var i=0;i<obj[prop].length;i++) {
            mapEnvVarProperties(obj[prop],i);
        }
    } else if (typeof obj[prop] === 'string') {
        var m;
        if ( (m = EnvVarPropertyRE.exec(obj[prop])) !== null) {
            if (process.env.hasOwnProperty(m[1])) {
                obj[prop] = process.env[m[1]];
            }
        }
    } else {
        for (var p in obj[prop]) {
            if (obj[prop].hasOwnProperty(p)) {
                mapEnvVarProperties(obj[prop],p);
            }
        }
    }
}

module.exports = {

    diffNodes: diffNodes,
    compareNodes: function(oldNode, newNode) {
        return !diffNodes(oldNode, newNode);
    },
    mapEnvVarProperties: mapEnvVarProperties,

    parseConfig: function(config) {
        var flow = {};
        flow.allNodes = {};
        flow.subflows = {};
        flow.configs = {};
        flow.flows = {};
        flow.missingTypes = [];

        config.forEach(function(n) {
            flow.allNodes[n.id] = clone(n);
            if (n.type === 'tab') {
                flow.flows[n.id] = n;
                flow.flows[n.id].subflows = {};
                flow.flows[n.id].configs = {};
                flow.flows[n.id].nodes = {};
            }
        });

        config.forEach(function(n) {
            if (n.type === 'subflow') {
                flow.subflows[n.id] = n;
                flow.subflows[n.id].configs = {};
                flow.subflows[n.id].nodes = {};
                flow.subflows[n.id].instances = [];
            }
        });
        var linkWires = {};
        var linkOutNodes = [];
        config.forEach(function(n) {
            if (n.type !== 'subflow' && n.type !== 'tab') {
                var subflowDetails = subflowInstanceRE.exec(n.type);

                if ( (subflowDetails && !flow.subflows[subflowDetails[1]]) || (!subflowDetails && !typeRegistry.get(n.type)) ) {
                    if (flow.missingTypes.indexOf(n.type) === -1) {
                        flow.missingTypes.push(n.type);
                    }
                }
                var container = null;
                if (flow.flows[n.z]) {
                    container = flow.flows[n.z];
                } else if (flow.subflows[n.z]) {
                    container = flow.subflows[n.z];
                }
                if (n.hasOwnProperty('x') && n.hasOwnProperty('y')) {
                    if (subflowDetails) {
                        var subflowType = subflowDetails[1]
                        n.subflow = subflowType;
                        flow.subflows[subflowType].instances.push(n)
                    }
                    if (container) {
                        container.nodes[n.id] = n;
                    }
                } else {
                    if (container) {
                        container.configs[n.id] = n;
                    } else {
                        flow.configs[n.id] = n;
                        flow.configs[n.id]._users = [];
                    }
                }
                if (n.type === 'link in' && n.links) {
                    // Ensure wires are present in corresponding link out nodes
                    n.links.forEach(function(id) {
                        linkWires[id] = linkWires[id]||{};
                        linkWires[id][n.id] = true;
                    })
                } else if (n.type === 'link out' && n.links) {
                    linkWires[n.id] = linkWires[n.id]||{};
                    n.links.forEach(function(id) {
                        linkWires[n.id][id] = true;
                    })
                    linkOutNodes.push(n);
                }
            }
        });
        linkOutNodes.forEach(function(n) {
            var links = linkWires[n.id];
            var targets = Object.keys(links);
            n.wires = [targets];
        });


        var addedTabs = {};
        config.forEach(function(n) {
            if (n.type !== 'subflow' && n.type !== 'tab') {
                for (var prop in n) {
                    if (n.hasOwnProperty(prop) && prop !== 'id' && prop !== 'wires' && prop !== 'type' && prop !== '_users' && flow.configs.hasOwnProperty(n[prop])) {
                        // This property references a global config node
                        flow.configs[n[prop]]._users.push(n.id)
                    }
                }
                if (n.z && !flow.subflows[n.z]) {

                    if (!flow.flows[n.z]) {
                        flow.flows[n.z] = {type:'tab',id:n.z};
                        flow.flows[n.z].subflows = {};
                        flow.flows[n.z].configs = {};
                        flow.flows[n.z].nodes = {};
                        addedTabs[n.z] = flow.flows[n.z];
                    }
                    if (addedTabs[n.z]) {
                        if (n.hasOwnProperty('x') && n.hasOwnProperty('y')) {
                            addedTabs[n.z].nodes[n.id] = n;
                        } else {
                            addedTabs[n.z].configs[n.id] = n;
                        }
                    }
                }
            }
        });
        return flow;
    },

    parseConfigByFlow: function(config) {
        var shardedConfig = {
            _global: {
                configs: {},
                subflows: {},
                allNodes: {},
                missingTypes: []  // Track missing types for global/subflow nodes
            },
            _flows: {}
        };

        var i, n, flowId;

        // First pass: Identify all flows and global resources
        for (i = 0; i < config.length; i++) {
            n = config[i];

            if (n.type === 'tab') {
                // Initialize flow shard
                shardedConfig._flows[n.id] = {
                    allNodes: {},
                    flows: {},
                    configs: {},
                    subflows: {},
                    missingTypes: []
                };
                shardedConfig._flows[n.id].flows[n.id] = clone(n);
                shardedConfig._flows[n.id].flows[n.id].nodes = {};
                shardedConfig._flows[n.id].flows[n.id].configs = {};
                shardedConfig._flows[n.id].flows[n.id].subflows = {};
                shardedConfig._flows[n.id].allNodes[n.id] = shardedConfig._flows[n.id].flows[n.id];
            } else if (n.type === 'subflow') {
                // Global subflows
                shardedConfig._global.subflows[n.id] = clone(n);
                shardedConfig._global.subflows[n.id].configs = {};
                shardedConfig._global.subflows[n.id].nodes = {};
                shardedConfig._global.subflows[n.id].instances = [];
                shardedConfig._global.allNodes[n.id] = shardedConfig._global.subflows[n.id];
            }
        }

        // Second pass: Distribute nodes to their respective flow shards
        var linkWires = {};
        var linkOutNodes = {};
        var missingTypeSet = {};

        for (i = 0; i < config.length; i++) {
            n = config[i];

            if (n.type === 'tab' || n.type === 'subflow') {
                continue; // Already processed
            }

            var clonedNode = clone(n);
            flowId = n.z;

            // Determine target shard
            var targetShard = null;
            if (flowId && shardedConfig._flows[flowId]) {
                targetShard = shardedConfig._flows[flowId];
            } else if (flowId && shardedConfig._global.subflows[flowId]) {
                // Node belongs to a subflow - add to global
                targetShard = shardedConfig._global;
            }

            if (!targetShard && !flowId) {
                // Global config node
                targetShard = shardedConfig._global;
            }

            if (targetShard) {
                targetShard.allNodes[n.id] = clonedNode;

                // Check for missing types
                var subflowDetails = subflowInstanceRE.exec(n.type);
                if (!missingTypeSet[n.type]) {
                    if ((subflowDetails && !shardedConfig._global.subflows[subflowDetails[1]]) ||
                        (!subflowDetails && !typeRegistry.get(n.type))) {
                        // Add to appropriate shard
                        if (flowId && shardedConfig._flows[flowId]) {
                            // Node in a flow tab
                            shardedConfig._flows[flowId].missingTypes.push(n.type);
                        } else {
                            // Global config node or node in subflow
                            shardedConfig._global.missingTypes.push(n.type);
                        }
                        missingTypeSet[n.type] = true;
                    }
                }

                // Categorize node
                var container = null;
                if (flowId && targetShard.flows && targetShard.flows[flowId]) {
                    container = targetShard.flows[flowId];
                } else if (flowId && shardedConfig._global.subflows[flowId]) {
                    container = shardedConfig._global.subflows[flowId];
                }

                if (n.x !== undefined && n.y !== undefined) {
                    // Regular node with position
                    if (subflowDetails) {
                        var subflowType = subflowDetails[1];
                        clonedNode.subflow = subflowType;
                        if (shardedConfig._global.subflows[subflowType]) {
                            shardedConfig._global.subflows[subflowType].instances.push(clonedNode);
                        }
                    }
                    if (container) {
                        container.nodes[n.id] = clonedNode;
                    }
                } else {
                    // Config node
                    if (container) {
                        container.configs[n.id] = clonedNode;
                    } else {
                        targetShard.configs[n.id] = clonedNode;
                        clonedNode._users = [];
                    }
                }

                // Track link nodes per flow
                if (n.type === 'link in' && n.links) {
                    if (!linkWires[flowId]) linkWires[flowId] = {};
                    n.links.forEach(function(id) {
                        linkWires[flowId][id] = linkWires[flowId][id] || {};
                        linkWires[flowId][id][n.id] = true;
                    });
                } else if (n.type === 'link out' && n.links) {
                    if (!linkWires[flowId]) linkWires[flowId] = {};
                    if (!linkOutNodes[flowId]) linkOutNodes[flowId] = [];
                    linkWires[flowId][n.id] = linkWires[flowId][n.id] || {};
                    n.links.forEach(function(id) {
                        linkWires[flowId][n.id][id] = true;
                    });
                    linkOutNodes[flowId].push(clonedNode);
                }
            }
        }

        // Third pass: Process link nodes per flow
        for (flowId in linkOutNodes) {
            if (linkOutNodes.hasOwnProperty(flowId)) {
                linkOutNodes[flowId].forEach(function(n) {
                    if (linkWires[flowId] && linkWires[flowId][n.id]) {
                        n.wires = [Object.keys(linkWires[flowId][n.id])];
                    }
                });
            }
        }

        // Fourth pass: Build config _users per shard
        for (flowId in shardedConfig._flows) {
            if (shardedConfig._flows.hasOwnProperty(flowId)) {
                var shard = shardedConfig._flows[flowId];
                for (var nodeId in shard.allNodes) {
                    if (shard.allNodes.hasOwnProperty(nodeId)) {
                        var node = shard.allNodes[nodeId];
                        if (node.type !== 'tab' && node.type !== 'subflow') {
                            for (var prop in node) {
                                if (node.hasOwnProperty(prop) && prop !== 'id' && prop !== 'wires' &&
                                    prop !== 'type' && prop !== '_users') {
                                    // Check local configs
                                    if (shard.configs[node[prop]]) {
                                        shard.configs[node[prop]]._users.push(node.id);
                                    }
                                    // Check global configs
                                    if (shardedConfig._global.configs[node[prop]]) {
                                        if (!shardedConfig._global.configs[node[prop]]._users) {
                                            shardedConfig._global.configs[node[prop]]._users = [];
                                        }
                                        shardedConfig._global.configs[node[prop]]._users.push(node.id);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        return shardedConfig;
    },

    mergeShardedConfig: function(shardedConfig) {
        var merged = {
            allNodes: {},
            flows: {},
            configs: {},
            subflows: {},
            missingTypes: []
        };

        var nodeId, node;

        for (nodeId in shardedConfig._global.configs) {
            if (shardedConfig._global.configs.hasOwnProperty(nodeId)) {
                node = shardedConfig._global.configs[nodeId];
                merged.configs[nodeId] = Object.assign({}, node);
                merged.allNodes[nodeId] = merged.configs[nodeId];
            }
        }

        for (nodeId in shardedConfig._global.subflows) {
            if (shardedConfig._global.subflows.hasOwnProperty(nodeId)) {
                node = shardedConfig._global.subflows[nodeId];
                merged.subflows[nodeId] = Object.assign({}, node);

                merged.subflows[nodeId].nodes = node.nodes;
                merged.subflows[nodeId].configs = node.configs;
                merged.subflows[nodeId].instances = node.instances;
                merged.allNodes[nodeId] = merged.subflows[nodeId];
            }
        }

        for (var flowId in shardedConfig._flows) {
            if (shardedConfig._flows.hasOwnProperty(flowId)) {
                var shard = shardedConfig._flows[flowId];

                for (nodeId in shard.flows) {
                    if (shard.flows.hasOwnProperty(nodeId)) {
                        node = shard.flows[nodeId];
                        merged.flows[nodeId] = Object.assign({}, node);

                        merged.flows[nodeId].nodes = node.nodes;
                        merged.flows[nodeId].configs = node.configs;
                        merged.flows[nodeId].subflows = node.subflows;
                        merged.allNodes[nodeId] = merged.flows[nodeId];
                    }
                }

                for (nodeId in shard.allNodes) {
                    if (shard.allNodes.hasOwnProperty(nodeId) && !merged.allNodes[nodeId]) {
                        node = shard.allNodes[nodeId];
                        merged.allNodes[nodeId] = Object.assign({}, node);
                    }
                }

                for (nodeId in shard.configs) {
                    if (shard.configs.hasOwnProperty(nodeId)) {
                        node = shard.configs[nodeId];
                        merged.configs[nodeId] = Object.assign({}, node);
                    }
                }

                merged.missingTypes = merged.missingTypes.concat(shard.missingTypes);
            }
        }

        // Include global missing types (for global configs and subflow nodes)
        if (shardedConfig._global.missingTypes) {
            merged.missingTypes = merged.missingTypes.concat(shardedConfig._global.missingTypes);
        }

        return merged;
    },

    updateFlowShard: function(shardedConfig, flowId, updatedNodes, removedNodeIds) {
        if (!shardedConfig._flows[flowId]) {
            return null;
        }

        var shard = shardedConfig._flows[flowId];
        var i, node, nodeId;

        for (i = 0; i < removedNodeIds.length; i++) {
            nodeId = removedNodeIds[i];
            delete shard.allNodes[nodeId];
            if (shard.flows[flowId] && shard.flows[flowId].nodes) {
                delete shard.flows[flowId].nodes[nodeId];
            }
            if (shard.flows[flowId] && shard.flows[flowId].configs) {
                delete shard.flows[flowId].configs[nodeId];
            }
        }

        for (i = 0; i < updatedNodes.length; i++) {
            node = clone(updatedNodes[i]);
            shard.allNodes[node.id] = node;

            var container = shard.flows[flowId];
            if (container) {
                if (node.x !== undefined && node.y !== undefined) {
                    container.nodes[node.id] = node;
                } else {
                    container.configs[node.id] = node;
                }
            }
        }

        for (nodeId in shard.configs) {
            if (shard.configs.hasOwnProperty(nodeId)) {
                shard.configs[nodeId]._users = [];
            }
        }

        for (nodeId in shard.allNodes) {
            if (shard.allNodes.hasOwnProperty(nodeId)) {
                node = shard.allNodes[nodeId];
                if (node.type !== 'tab') {
                    for (var prop in node) {
                        if (node.hasOwnProperty(prop) && prop !== 'id' && prop !== 'wires' &&
                            prop !== 'type' && prop !== '_users' && shard.configs[node[prop]]) {
                            shard.configs[node[prop]]._users.push(node.id);
                        }
                    }
                }
            }
        }

        return shard;
    },

    diffConfigs: function(oldConfig, newConfig) {
        var id;
        var node;
        var nn;
        var wires;
        var j,k;

        if (!oldConfig) {
            oldConfig = {
                flows:{},
                allNodes:{}
            }
        }
        var changedSubflows = {};

        var added = {};
        var removed = {};
        var changed = {};
        var wiringChanged = {};

        var linkMap = {};

        var changedTabs = {};
        
        // Look for tabs that have been removed
        for (id in oldConfig.flows) {
            if (oldConfig.flows.hasOwnProperty(id) && (!newConfig.flows.hasOwnProperty(id))) {
                removed[id] = oldConfig.allNodes[id];
            }
        }

        // Look for tabs that have been disabled
        for (id in oldConfig.flows) {
            if (oldConfig.flows.hasOwnProperty(id) && newConfig.flows.hasOwnProperty(id)) {
                var originalState = oldConfig.flows[id].disabled||false;
                var newState = newConfig.flows[id].disabled||false;
                if (originalState !== newState) {
                    changedTabs[id] = true;
                    if (originalState) {
                        added[id] = oldConfig.allNodes[id];
                    } else {
                        removed[id] = oldConfig.allNodes[id];
                    }
                }
            }
        }

        for (id in oldConfig.allNodes) {
            if (oldConfig.allNodes.hasOwnProperty(id)) {
                node = oldConfig.allNodes[id];
                if (node.type !== 'tab') {
                    // build the map of what this node was previously wired to
                    if (node.wires) {
                        linkMap[node.id] = linkMap[node.id] || [];
                        for (j=0;j<node.wires.length;j++) {
                            wires = node.wires[j];
                            for (k=0;k<wires.length;k++) {
                                linkMap[node.id].push(wires[k]);
                                nn = oldConfig.allNodes[wires[k]];
                                if (nn) {
                                    linkMap[nn.id] = linkMap[nn.id] || [];
                                    linkMap[nn.id].push(node.id);
                                }
                            }
                        }
                    }
                    // This node has been removed
                    if (removed[node.z] || !newConfig.allNodes.hasOwnProperty(id)) {
                        removed[id] = node;
                        // Mark the container as changed
                        if (!removed[node.z] && newConfig.allNodes[removed[id].z]) {
                            changed[removed[id].z] = newConfig.allNodes[removed[id].z];
                            if (changed[removed[id].z].type === "subflow") {
                                changedSubflows[removed[id].z] = changed[removed[id].z];
                                //delete removed[id];
                            }
                        }
                    } else {
                        if (added[node.z]) {
                            added[id] = node;
                        } else {
                            // This node has a material configuration change
                            if (diffNodes(node,newConfig.allNodes[id]) || newConfig.allNodes[id].credentials) {
                                changed[id] = newConfig.allNodes[id];
                                if (changed[id].type === "subflow") {
                                    changedSubflows[id] = changed[id];
                                }
                                // Mark the container as changed
                                if (newConfig.allNodes[changed[id].z]) {
                                    changed[changed[id].z] = newConfig.allNodes[changed[id].z];
                                    if (changed[changed[id].z].type === "subflow") {
                                        changedSubflows[changed[id].z] = changed[changed[id].z];
                                        delete changed[id];
                                    }
                                }
                            }
                            // This node's wiring has changed
                            if (!redUtil.compareObjects(node.wires,newConfig.allNodes[id].wires)) {
                                wiringChanged[id] = newConfig.allNodes[id];
                                // Mark the container as changed
                                if (newConfig.allNodes[wiringChanged[id].z]) {
                                    changed[wiringChanged[id].z] = newConfig.allNodes[wiringChanged[id].z];
                                    if (changed[wiringChanged[id].z].type === "subflow") {
                                        changedSubflows[wiringChanged[id].z] = changed[wiringChanged[id].z];
                                        delete wiringChanged[id];
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        // Look for added nodes
        for (id in newConfig.allNodes) {
            if (newConfig.allNodes.hasOwnProperty(id)) {
                node = newConfig.allNodes[id];
                // build the map of what this node is now wired to
                if (node.wires) {
                    linkMap[node.id] = linkMap[node.id] || [];
                    for (j=0;j<node.wires.length;j++) {
                        wires = node.wires[j];
                        for (k=0;k<wires.length;k++) {
                            if (linkMap[node.id].indexOf(wires[k]) === -1) {
                                linkMap[node.id].push(wires[k]);
                            }
                            nn = newConfig.allNodes[wires[k]];
                            if (nn) {
                                linkMap[nn.id] = linkMap[nn.id] || [];
                                if (linkMap[nn.id].indexOf(node.id) === -1) {
                                    linkMap[nn.id].push(node.id);
                                }
                            }
                        }
                    }
                }
                // This node has been added
                if (!oldConfig.allNodes.hasOwnProperty(id)) {
                    added[id] = node;
                    // Mark the container as changed
                    if (newConfig.allNodes[added[id].z]) {
                        changed[added[id].z] = newConfig.allNodes[added[id].z];
                        if (changed[added[id].z].type === "subflow") {
                            changedSubflows[added[id].z] = changed[added[id].z];
                            delete added[id];
                        }
                    }
                }
            }
        }

        var madeChange;
        // Loop through the nodes looking for references to changed config nodes
        // Repeat the loop if anything is marked as changed as it may need to be
        // propagated to parent nodes.
        // TODO: looping through all nodes every time is a bit inefficient - could be more targeted
        do {
            madeChange = false;
            for (id in newConfig.allNodes) {
                if (newConfig.allNodes.hasOwnProperty(id)) {
                    node = newConfig.allNodes[id];
                    for (var prop in node) {
                        if (node.hasOwnProperty(prop) && prop != "z" && prop != "id" && prop != "wires") {
                            // This node has a property that references a changed/removed node
                            // Assume it is a config node change and mark this node as
                            // changed.
                            if (changed[node[prop]] || removed[node[prop]]) {
                                if (!changed[node.id]) {
                                    madeChange = true;
                                    changed[node.id] = node;
                                    // This node exists within subflow template
                                    // Mark the template as having changed
                                    if (newConfig.allNodes[node.z]) {
                                        changed[node.z] = newConfig.allNodes[node.z];
                                        if (changed[node.z].type === "subflow") {
                                            changedSubflows[node.z] = changed[node.z];
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } while (madeChange===true)

        // Find any nodes that exist on a subflow template and remove from changed
        // list as the parent subflow will now be marked as containing a change
        for (id in newConfig.allNodes) {
            if (newConfig.allNodes.hasOwnProperty(id)) {
                node = newConfig.allNodes[id];
                if (newConfig.allNodes[node.z] && newConfig.allNodes[node.z].type === "subflow") {
                    delete changed[node.id];
                }
            }
        }

        // Recursively mark all instances of changed subflows as changed
        var changedSubflowStack = Object.keys(changedSubflows);
        while (changedSubflowStack.length > 0) {
            var subflowId = changedSubflowStack.pop();
            for (id in newConfig.allNodes) {
                if (newConfig.allNodes.hasOwnProperty(id)) {
                    node = newConfig.allNodes[id];
                    if (node.type === 'subflow:'+subflowId) {
                        if (!changed[node.id]) {
                            changed[node.id] = node;
                            if (!changed[changed[node.id].z] && newConfig.allNodes[changed[node.id].z]) {
                                changed[changed[node.id].z] = newConfig.allNodes[changed[node.id].z];
                                if (newConfig.allNodes[changed[node.id].z].type === "subflow") {
                                    // This subflow instance is inside a subflow. Add the
                                    // containing subflow to the stack to mark
                                    changedSubflowStack.push(changed[node.id].z);
                                    delete changed[node.id];
                                }
                            }
                        }
                    }
                }
            }
        }

        var diff = {
            added:Object.keys(added),
            changed:Object.keys(changed),
            removed:Object.keys(removed),
            rewired:Object.keys(wiringChanged),
            linked:[]
        }

        // Traverse the links of all modified nodes to mark the connected nodes
        var modifiedNodes = diff.added.concat(diff.changed).concat(diff.removed).concat(diff.rewired);
        var visited = {};
        while (modifiedNodes.length > 0) {
            node = modifiedNodes.pop();
            if (!visited[node]) {
                visited[node] = true;
                if (linkMap[node]) {
                    if (!changed[node] && !added[node] && !removed[node] && !wiringChanged[node]) {
                        diff.linked.push(node);
                    }
                    modifiedNodes = modifiedNodes.concat(linkMap[node]);
                }
            }
        }
        // console.log(diff);
        // for (id in newConfig.allNodes) {
        //     console.log(
        //         (added[id]?"+":(changed[id]?"!":" "))+(wiringChanged[id]?"w":" ")+(diff.linked.indexOf(id)!==-1?"~":" "),
        //         id,
        //         newConfig.allNodes[id].type,
        //         newConfig.allNodes[id].name||newConfig.allNodes[id].label||""
        //     );
        // }
        // for (id in removed) {
        //     console.log(
        //         "- "+(diff.linked.indexOf(id)!==-1?"~":" "),
        //         id,
        //         oldConfig.allNodes[id].type,
        //         oldConfig.allNodes[id].name||oldConfig.allNodes[id].label||""
        //     );
        // }

        return diff;
    }
}
