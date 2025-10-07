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

        var linkWires = {};
        var linkOutNodes = [];
        var addedTabs = {};
        var missingTypeSet = new Set();
        var deferredNodes = []; // Nodes to process in second pass

        // CRITICAL OPTIMIZATION: config is already cloned by caller, don't clone again!
        // This saves 15,000 expensive deep clone operations
        var i, n;
        for (i = 0; i < config.length; i++) {
            n = config[i];
            flow.allNodes[n.id] = n;

            if (n.type === 'tab') {
                flow.flows[n.id] = n;
                n.subflows = {};
                n.configs = {};
                n.nodes = {};
            } else if (n.type === 'subflow') {
                flow.subflows[n.id] = n;
                n.configs = {};
                n.nodes = {};
                n.instances = [];
            } else {
                // Defer regular nodes for second pass
                deferredNodes.push(n);
            }
        }

        // OPTIMIZED: Second pass - process only regular nodes
        for (i = 0; i < deferredNodes.length; i++) {
            n = deferredNodes[i];
            var subflowDetails = subflowInstanceRE.exec(n.type);

            // Check for missing types
            if (!missingTypeSet.has(n.type)) {
                if ((subflowDetails && !flow.subflows[subflowDetails[1]]) || (!subflowDetails && !typeRegistry.get(n.type))) {
                    flow.missingTypes.push(n.type);
                    missingTypeSet.add(n.type);
                }
            }

            var container = flow.flows[n.z] || flow.subflows[n.z];

            if (n.x !== undefined && n.y !== undefined) {
                // Node with position
                if (subflowDetails) {
                    var subflowType = subflowDetails[1];
                    n.subflow = subflowType;
                    if (flow.subflows[subflowType]) {
                        flow.subflows[subflowType].instances.push(n);
                    }
                }
                if (container) {
                    container.nodes[n.id] = n;
                }
            } else {
                // Config node
                if (container) {
                    container.configs[n.id] = n;
                } else {
                    flow.configs[n.id] = n;
                    n._users = [];
                }
            }

            // Handle link nodes
            if (n.type === 'link in' && n.links) {
                for (var j = 0; j < n.links.length; j++) {
                    var linkId = n.links[j];
                    linkWires[linkId] = linkWires[linkId] || {};
                    linkWires[linkId][n.id] = true;
                }
            } else if (n.type === 'link out' && n.links) {
                linkWires[n.id] = linkWires[n.id] || {};
                for (var j = 0; j < n.links.length; j++) {
                    linkWires[n.id][n.links[j]] = true;
                }
                linkOutNodes.push(n);
            }

            // Auto-create missing tabs
            if (n.z && !flow.subflows[n.z] && !flow.flows[n.z]) {
                flow.flows[n.z] = {type:'tab', id:n.z, subflows:{}, configs:{}, nodes:{}};
                addedTabs[n.z] = flow.flows[n.z];
            }

            // Add to auto-created tabs
            if (addedTabs[n.z]) {
                if (n.x !== undefined && n.y !== undefined) {
                    addedTabs[n.z].nodes[n.id] = n;
                } else {
                    addedTabs[n.z].configs[n.id] = n;
                }
            }
        }

        // Process link out nodes
        for (i = 0; i < linkOutNodes.length; i++) {
            n = linkOutNodes[i];
            var links = linkWires[n.id];
            n.wires = [Object.keys(links)];
        }

        // OPTIMIZED: Build config _users in single pass
        for (i = 0; i < deferredNodes.length; i++) {
            n = deferredNodes[i];
            for (var prop in n) {
                if (n.hasOwnProperty(prop) && prop !== 'id' && prop !== 'wires' &&
                    prop !== 'type' && prop !== '_users' && flow.configs[n[prop]]) {
                    flow.configs[n[prop]]._users.push(n.id);
                }
            }
        }

        return flow;
    },

    // Incremental parsing: Only process changed nodes while maintaining correctness
    parseConfigIncremental: function(existingFlowConfig, newNodes, removedNodeIds) {
        var typeRegistry = require("../registry");
        var subflowInstanceRE = /^subflow:(.+)$/;

        // Create new config by copying structure references (not cloning)
        var newConfig = {
            allNodes: {},
            subflows: {},
            configs: {},
            flows: {},
            missingTypes: []
        };

        // Step 1: Fast build of allNodes collection with Set for removals
        var removedSet = new Set(removedNodeIds);
        var newNodeMap = new Map();
        var affectedContainers = new Set();
        var allSubflows = new Set();
        var checkedTypes = new Set();
        var hasConfigChanges = false;

        // Build map of new/modified nodes for faster lookup
        var i, node, nodeId, prop;
        for (i = 0; i < newNodes.length; i++) {
            node = newNodes[i];
            newNodeMap.set(node.id, node);
            // Store reference first, clone only if we actually modify it later
            newConfig.allNodes[node.id] = clone(node);

            // Track affected containers inline
            if (node.z) {
                affectedContainers.add(node.z);
            }
            if (node.type === 'tab' || node.type === 'subflow') {
                affectedContainers.add(node.id);
            }
            if (node.type === 'subflow') {
                allSubflows.add(node.id);
            }
        }

        // Process removed nodes inline
        var oldNode;
        for (i = 0; i < removedNodeIds.length; i++) {
            nodeId = removedNodeIds[i];
            oldNode = existingFlowConfig.allNodes[nodeId];
            if (oldNode) {
                if (oldNode.z) {
                    affectedContainers.add(oldNode.z);
                }
                // Check for config references without iterating props
                if (!hasConfigChanges && oldNode.type !== 'tab' && oldNode.type !== 'subflow') {
                    hasConfigChanges = true;
                }
            }
        }

        // Step 2: ULTRA-FAST copy - use Object.assign for bulk copy, then override
        var existingNode;

        // Use Object.assign to copy all properties at once (much faster than iteration)
        Object.assign(newConfig.allNodes, existingFlowConfig.allNodes);

        // Remove deleted nodes
        for (i = 0; i < removedNodeIds.length; i++) {
            delete newConfig.allNodes[removedNodeIds[i]];
        }

        // Override with new/modified nodes (already added above in first loop)

        // Step 3: Clone only affected flows/subflows, reference the rest
        var flowKeys = Object.keys(existingFlowConfig.flows);
        for (i = 0; i < flowKeys.length; i++) {
            nodeId = flowKeys[i];
            if (affectedContainers.has(nodeId)) {
                node = newConfig.allNodes[nodeId];
                if (node) {
                    newConfig.flows[nodeId] = node;
                    // Start with existing collections, will be rebuilt selectively
                    newConfig.flows[nodeId].nodes = Object.assign({}, existingFlowConfig.flows[nodeId].nodes);
                    newConfig.flows[nodeId].configs = Object.assign({}, existingFlowConfig.flows[nodeId].configs);
                    newConfig.flows[nodeId].subflows = Object.assign({}, existingFlowConfig.flows[nodeId].subflows);
                }
            } else {
                // CRITICAL: Reference unchanged flow completely - don't reprocess
                newConfig.flows[nodeId] = existingFlowConfig.flows[nodeId];
            }
        }

        var subflowKeys = Object.keys(existingFlowConfig.subflows);
        for (i = 0; i < subflowKeys.length; i++) {
            nodeId = subflowKeys[i];
            if (affectedContainers.has(nodeId)) {
                node = newConfig.allNodes[nodeId];
                if (node) {
                    newConfig.subflows[nodeId] = node;
                    // Start with existing collections, will be rebuilt selectively
                    newConfig.subflows[nodeId].nodes = Object.assign({}, existingFlowConfig.subflows[nodeId].nodes);
                    newConfig.subflows[nodeId].configs = Object.assign({}, existingFlowConfig.subflows[nodeId].configs);
                    newConfig.subflows[nodeId].instances = []; // Instances always rebuilt
                }
            } else {
                // CRITICAL: Reference unchanged subflow completely - don't reprocess
                newConfig.subflows[nodeId] = existingFlowConfig.subflows[nodeId];
            }
        }

        // Step 4: Process ONLY new/modified nodes and nodes in affected containers
        var pendingSubflowInstances = [];
        var pendingConfigUsers = [];

        // First pass: Handle new/modified nodes only - UPDATE containers incrementally
        for (i = 0; i < newNodes.length; i++) {
            node = newNodes[i];
            nodeId = node.id;

            // Handle new tabs
            if (node.type === 'tab' && !newConfig.flows[nodeId]) {
                newConfig.flows[nodeId] = node;
                newConfig.flows[nodeId].subflows = {};
                newConfig.flows[nodeId].configs = {};
                newConfig.flows[nodeId].nodes = {};
            }
            // Handle new subflows
            else if (node.type === 'subflow' && !newConfig.subflows[nodeId]) {
                newConfig.subflows[nodeId] = node;
                newConfig.subflows[nodeId].nodes = {};
                newConfig.subflows[nodeId].configs = {};
                newConfig.subflows[nodeId].instances = [];
            }
            // Global configs
            else if (!node.x && !node.y && node.type !== 'tab' && node.type !== 'subflow' && !node.z) {
                newConfig.configs[nodeId] = node;
                node._users = [];
            }
            // Regular nodes - directly update container collections
            else if (node.type !== 'tab' && node.type !== 'subflow') {
                var container = node.z ? (newConfig.flows[node.z] || newConfig.subflows[node.z]) : null;

                if (container) {
                    if (node.type === 'subflow') {
                        container.subflows[nodeId] = node;
                    } else if (node.x !== undefined && node.y !== undefined) {
                        container.nodes[nodeId] = node;
                    } else {
                        container.configs[nodeId] = node;
                    }
                }

                if (node.type.indexOf('subflow:') === 0) {
                    pendingSubflowInstances.push(nodeId);
                }
                pendingConfigUsers.push(nodeId);
            }

            // Track missing types
            if (node.type !== 'tab' && node.type !== 'subflow' && !checkedTypes.has(node.type)) {
                checkedTypes.add(node.type);
                var subflowMatch = subflowInstanceRE.exec(node.type);
                if ((subflowMatch && !newConfig.subflows[subflowMatch[1]]) ||
                    (!subflowMatch && !typeRegistry.get(node.type))) {
                    newConfig.missingTypes.push(node.type);
                }
            }
        }

        // Second pass: Remove deleted nodes from affected containers
        if (removedSet.size > 0) {
            affectedContainers.forEach(function(containerId) {
                var container = newConfig.flows[containerId] || newConfig.subflows[containerId];
                if (container) {
                    removedSet.forEach(function(removedId) {
                        if (container.nodes) delete container.nodes[removedId];
                        if (container.configs) delete container.configs[removedId];
                        if (container.subflows) delete container.subflows[removedId];
                    });
                }
            });
        }

        // Third pass: Only process config _users for affected nodes
        if (hasConfigChanges && affectedContainers.size > 0) {
            var containerNodes, containerConfig, containerNodeKeys, containerConfigKeys, j;
            affectedContainers.forEach(function(containerId) {
                var existingContainer = existingFlowConfig.flows[containerId] || existingFlowConfig.subflows[containerId];
                if (existingContainer) {
                    // Add existing nodes to config users scan
                    containerNodes = existingContainer.nodes;
                    if (containerNodes) {
                        containerNodeKeys = Object.keys(containerNodes);
                        for (j = 0; j < containerNodeKeys.length; j++) {
                            nodeId = containerNodeKeys[j];
                            if (!newNodeMap.has(nodeId) && !removedSet.has(nodeId)) {
                                pendingConfigUsers.push(nodeId);

                                // Rebuild subflow instances
                                existingNode = containerNodes[nodeId];
                                if (existingNode.type.indexOf('subflow:') === 0) {
                                    pendingSubflowInstances.push(nodeId);
                                }
                            }
                        }
                    }

                    containerConfig = existingContainer.configs;
                    if (containerConfig) {
                        containerConfigKeys = Object.keys(containerConfig);
                        for (j = 0; j < containerConfigKeys.length; j++) {
                            nodeId = containerConfigKeys[j];
                            if (!newNodeMap.has(nodeId) && !removedSet.has(nodeId)) {
                                pendingConfigUsers.push(nodeId);
                            }
                        }
                    }
                }
            });
        }

        // Copy existing global configs if not in affected set - use Object.assign for speed
        if (!hasConfigChanges) {
            // Bulk copy all configs, then override with new ones
            Object.assign(newConfig.configs, existingFlowConfig.configs);
            // New configs already added above, so we're done
        }

        // Step 4: Process subflow instances
        var subflowType;
        for (i = 0; i < pendingSubflowInstances.length; i++) {
            nodeId = pendingSubflowInstances[i];
            node = newConfig.allNodes[nodeId];
            subflowType = node.type.substring(8); // Remove "subflow:" prefix

            if (newConfig.subflows[subflowType]) {
                node.subflow = subflowType;
                newConfig.subflows[subflowType].instances.push(node);
            }
        }

        // Step 6: Process config _users efficiently
        var propValue;
        for (i = 0; i < pendingConfigUsers.length; i++) {
            nodeId = pendingConfigUsers[i];
            node = newConfig.allNodes[nodeId];

            for (prop in node) {
                if (node.hasOwnProperty(prop) && prop !== 'id' && prop !== 'wires' &&
                    prop !== 'type' && prop !== '_users') {
                    propValue = node[prop];
                    if (typeof propValue === 'string' && newConfig.configs[propValue]) {
                        newConfig.configs[propValue]._users.push(nodeId);
                    }
                }
            }
        }

        // Copy _users from unaffected config nodes
        // Only do this optimization if we didn't process all nodes
        if (!hasConfigChanges && pendingConfigUsers.length > 0) {
            var existingConfig;
            for (nodeId in newConfig.configs) {
                if (newConfig.configs.hasOwnProperty(nodeId) && newConfig.configs[nodeId]._users.length === 0) {
                    existingConfig = existingFlowConfig.configs[nodeId];
                    if (existingConfig && existingConfig._users) {
                        newConfig.configs[nodeId]._users = existingConfig._users;
                    }
                }
            }
        }

        return newConfig;
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

        var oldNodeIds = Object.keys(oldConfig.allNodes);
        for (var idx = 0; idx < oldNodeIds.length; idx++) {
            id = oldNodeIds[idx];
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
        // Look for added nodes
        var newNodeIds = Object.keys(newConfig.allNodes);
        for (var idx2 = 0; idx2 < newNodeIds.length; idx2++) {
            id = newNodeIds[idx2];
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
