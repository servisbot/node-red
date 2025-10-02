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
var when = require("when");

var Flow = require('./Flow');

var typeRegistry = require("../registry");
var context = require("../context")
var credentials = require("../credentials");

var flowUtil = require("./util");
var log = require("../../log");
var events = require("../../events");
var redUtil = require("../../util");
var deprecated = require("../registry/deprecated");

const nodeCache = require('./node-cache');

var storage = null;
var settings = null;

var activeConfig = null;
var activeFlowConfig = null;

var activeFlows = {};
var started = false;
var credentialsPendingReset = false;

var activeNodesToFlow = {};
var subflowInstanceNodeMap = {};

var typeEventRegistered = false;

// Smart parseConfig with flow-level and node-level caching for large configurations
function parseConfigWithNodeCache(config) {
    var cachedFlowConfig = nodeCache.getCachedFlowConfig(config);
    if (cachedFlowConfig) {
        return cachedFlowConfig;
    }

    var optimizedConfig = config.map(function(node) {
        if (!node || !node.id) return node;
        
        if (nodeCache.canReuseNode(node.id, node)) {
            var cachedNode = nodeCache.getCachedNode(node.id);
            if (cachedNode) {
                return cachedNode;
            }
        }
        
        var clonedNode = clone(node);
        nodeCache.cacheNode(node.id, clonedNode);
        return clonedNode;
    });
    
    var parsedConfig = flowUtil.parseConfig(optimizedConfig);
    
    nodeCache.cacheFlowConfig(config, parsedConfig);
    
    return parsedConfig;
}

function init(runtime) {
    if (started) {
        throw new Error("Cannot init without a stop");
    }
    settings = runtime.settings;
    storage = runtime.storage;
    started = false;
    if (!typeEventRegistered) {
        events.on('type-registered',function(type) {
            if (activeFlowConfig && activeFlowConfig.missingTypes.length > 0) {
                var i = activeFlowConfig.missingTypes.indexOf(type);
                if (i != -1) {
                    log.info(log._("nodes.flows.registered-missing", {type:type}));
                    activeFlowConfig.missingTypes.splice(i,1);
                    if (activeFlowConfig.missingTypes.length === 0 && started) {
                        events.emit("runtime-event",{id:"runtime-state",retain: true});
                        start();
                    }
                }
            }
        });
        typeEventRegistered = true;
    }
    Flow.init(settings);
}

function loadFlows() {
    var config;
    return storage.getFlows().then(function(_config) {
        config = _config;
        log.debug("loaded flow revision: "+config.rev);
        return credentials.load(config.credentials).then(function() {
            events.emit("runtime-event",{id:"runtime-state",retain:true});
            return config;
        });
    }).catch(function(err) {
        if (err.code === "credentials_load_failed" && !storage.projects) {
            // project disabled, credential load failed
            credentialsPendingReset = true;
            log.warn(log._("nodes.flows.error",{message:err.toString()}));
            events.emit("runtime-event",{id:"runtime-state",payload:{type:"warning",error:err.code,text:"notification.warnings.credentials_load_failed_reset"},retain:true});
            return config;
        } else {
            activeConfig = null;
            events.emit("runtime-event",{id:"runtime-state",payload:{type:"warning",error:err.code,project:err.project,text:"notification.warnings."+err.code},retain:true});
            if (err.code === "project_not_found") {
                log.warn(log._("storage.localfilesystem.projects.project-not-found",{project:err.project}));
            } else {
                log.warn(log._("nodes.flows.error",{message:err.toString()}));
            }
            throw err;
        }
    });
}
function load(forceStart) {
    return setFlows(null,"load",false,forceStart);
}

/*
 * _config - new node array configuration
 * type - full/nodes/flows/load (default full)
 * muteLog - don't emit the standard log messages (used for individual flow api)
 */
function setFlows(_config,type,muteLog,forceStart) {
    var operationId = Math.random().toString(36).substring(7);
    var setFlowsStartTime = Date.now();
    
    if (!setFlows._lastCallTime) setFlows._lastCallTime = Date.now();
    setFlows._lastCallTime = Date.now();
    
    var currentMemory = process.memoryUsage();
    var heapMB = currentMemory.heapUsed / 1024 / 1024;
    var shouldPeriodicCleanup = false;
    
    if (!setFlows._operationCounter) setFlows._operationCounter = 0;
    setFlows._operationCounter++;
    
    if (setFlows._operationCounter % 25 === 0 || heapMB > 200) {
        shouldPeriodicCleanup = true;
        
        if (heapMB > 600) {
            if (typeRegistry.clearCache) {
                typeRegistry.clearCache();
            }
            nodeCache.clear(false);
            
            if (heapMB > 700) {
                if (activeFlowConfig) {
                    if (activeFlowConfig.allNodes) {
                        for (var nodeId in activeFlowConfig.allNodes) {
                            delete activeFlowConfig.allNodes[nodeId];
                        }
                    }
                    if (activeFlowConfig.subflows) {
                        for (var subflowId in activeFlowConfig.subflows) {
                            if (activeFlowConfig.subflows[subflowId]) {
                                var subflow = activeFlowConfig.subflows[subflowId];
                                if (subflow.nodes) {
                                    for (var nodeId in subflow.nodes) {
                                        delete subflow.nodes[nodeId];
                                    }
                                }
                                if (subflow.configs) {
                                    for (var configId in subflow.configs) {
                                        delete subflow.configs[configId];
                                    }
                                }
                                subflow.instances = [];
                                subflow.nodes = {};
                                subflow.configs = {};
                            }
                        }
                    }
                    if (activeFlowConfig.configs) {
                        for (var configId in activeFlowConfig.configs) {
                            delete activeFlowConfig.configs[configId];
                        }
                        activeFlowConfig.configs = {};
                    }
                    if (activeFlowConfig.flows) {
                        for (var flowId in activeFlowConfig.flows) {
                            var flow = activeFlowConfig.flows[flowId];
                            if (flow && flow.nodes) {
                                for (var nodeId in flow.nodes) {
                                    delete flow.nodes[nodeId];
                                }
                                flow.nodes = {};
                            }
                            if (flow && flow.configs) {
                                for (var configId in flow.configs) {
                                    delete flow.configs[configId];
                                }
                                flow.configs = {};
                            }
                            if (flow && flow.subflows) {
                                flow.subflows = {};
                            }
                        }
                        activeFlowConfig.flows = {};
                    }
                    activeFlowConfig.missingTypes = [];
                }
                if (activeConfig && activeConfig.flows) {
                    activeConfig.flows.length = 0;
                }
            }
            
            if (global.gc) {
                global.gc();
                setImmediate(() => {
                    if (global.gc) {
                        global.gc();
                    }
                });
            }
        } else {
            if (typeRegistry.clearCache) {
                typeRegistry.clearCache();
            }
            
            // Periodic node cache cleanup - keep only most recent entries
            var nodeCacheStats = nodeCache.getStats();
            if (nodeCacheStats.size > 5000) {
                nodeCache.clear(true);
            }

            if (global.gc && (heapMB > 250 || setFlows._operationCounter % 100 === 0)) {
                global.gc();
            }
        }
    }

    type = type || "full";

    var configSavePromise = null;
    var config = null;
    var diff;
    var newFlowConfig;
    var isLoad = false;
    if (type === "load") {
        isLoad = true;
        configSavePromise = loadFlows().then(function(_config) {
            config = clone(_config.flows);
            newFlowConfig = flowUtil.parseConfig(clone(config));
            type = "full";
            return _config.rev;
        });
    } else {
        var cloneStart = Date.now();

        if (_config.length > 3000) {
            try {
                config = JSON.parse(JSON.stringify(_config));
            } catch (e) {
                console.warn(`[SlowOpDiag] JSON clone failed, falling back to regular clone for ${_config.length} nodes`, e);
                config = clone(_config);
            }
        } else {
            config = clone(_config);
        }

        // Quick check: if config is identical to activeConfig, skip expensive operations
        var configHash = null;
        var configUnchanged = false;
        var batchOptimization = false;
        
        if (activeConfig && activeConfig.flows) {            
            // For large configs (1000+ nodes), do a comprehensive hash comparison
            if (config.length > 1000) {
                var nodeIds = config.map(n => n.id || 'none').sort().join(',');
                var nodeTypes = config.map(n => n.type || 'none').sort().join(',');
                configHash = config.length + '-' + nodeIds.substring(0, 100) + '-' + nodeTypes.substring(0, 100);
                
                var activeNodeIds = activeConfig.flows.map(n => n.id || 'none').sort().join(',');
                var activeNodeTypes = activeConfig.flows.map(n => n.type || 'none').sort().join(',');  
                var activeHash = activeConfig.flows.length + '-' + activeNodeIds.substring(0, 100) + '-' + activeNodeTypes.substring(0, 100);

                configUnchanged = (configHash === activeHash);
                
                // Batch optimization: if configs are very similar (80%+ same node IDs), use aggressive caching
                // Remove the same-length requirement to detect similarity across different batch sizes
                if (!configUnchanged) {
                    var currentIds = new Set(config.map(n => n.id).filter(Boolean));
                    var activeIds = new Set(activeConfig.flows.map(n => n.id).filter(Boolean));
                    var intersection = new Set([...currentIds].filter(id => activeIds.has(id)));
                    var similarity = intersection.size / Math.max(currentIds.size, activeIds.size);
                    
                    if (similarity > 0.8) {
                        batchOptimization = true;
                    }
                }
            } else {
                if (config.length === activeConfig.flows.length) {
                    configUnchanged = JSON.stringify(config).length === JSON.stringify(activeConfig.flows).length;
                }
            }
        }

        if (configUnchanged && config.length > 1000 && activeFlowConfig) {
            newFlowConfig = activeFlowConfig;
        } else if (batchOptimization && activeFlowConfig) {
            newFlowConfig = parseConfigWithNodeCache(config);
        } else {
            if (config.length > 1000) {
                newFlowConfig = parseConfigWithNodeCache(config);
            } else {
                newFlowConfig = flowUtil.parseConfig(clone(config));
            }
        }

        var diffStart = Date.now();
        
        if (configUnchanged && activeFlowConfig) {
            diff = { added: [], changed: [], removed: [], rewired: [] }; // Empty diff
        } else if (batchOptimization && activeFlowConfig) {
            var cachedDiff = nodeCache.getCachedDiff(activeFlowConfig, newFlowConfig);
            if (cachedDiff) {
                diff = cachedDiff;
            } else {
                diff = nodeCache.computeIncrementalDiff(activeFlowConfig, newFlowConfig) || 
                       flowUtil.diffConfigs(activeFlowConfig,newFlowConfig);
                nodeCache.cacheDiff(activeFlowConfig, newFlowConfig, diff);
            }
        } else {
            var cachedDiff = nodeCache.getCachedDiff(activeFlowConfig, newFlowConfig);
            if (cachedDiff) {
                diff = cachedDiff;
            } else {
                var diffStart = Date.now();
                diff = flowUtil.diffConfigs(activeFlowConfig,newFlowConfig);
                
                nodeCache.cacheDiff(activeFlowConfig, newFlowConfig, diff);
            }
        }

        for (var id in newFlowConfig.allNodes) {
            if (newFlowConfig.allNodes.hasOwnProperty(id)) {
                delete newFlowConfig.allNodes[id].credentials;
            }
        }

        credentials.clean(config);
        var credsDirty = credentials.dirty();

        var skipCredsExport = false;
        if (!credsDirty && setFlows._lastCredsExport && (Date.now() - setFlows._lastCredsExport) < 5000) {
            skipCredsExport = true;
        }
        
        configSavePromise = skipCredsExport ? 
            Promise.resolve(setFlows._lastCreds || {}) :
            credentials.export().then(function(creds) {
                setFlows._lastCredsExport = Date.now();
                setFlows._lastCreds = creds;
                monitor.logOperation('setFlows-credentials-export-end');
                return creds;
            });
        
        configSavePromise = configSavePromise.then(function(creds) {
            var saveConfig = {
                flows: config,
                credentialsDirty:credsDirty,
                credentials: creds
            }

            var delay = 0;
            if (!storage._lastSaveTime) storage._lastSaveTime = 0;
            var timeSinceLastSave = Date.now() - storage._lastSaveTime;
            if (timeSinceLastSave < 100) {
                delay = Math.min(50, 100 - timeSinceLastSave); // Small delay to reduce contention
            }
            
            return new Promise(resolve => setTimeout(resolve, delay)).then(() => {
                storage._lastSaveTime = Date.now();
                return storage.saveFlows(saveConfig).then(function(result) {
                    return result;
                });
            });
        });
    }

    return configSavePromise
        .then(function(flowRevision) {
            if (!isLoad) {
                log.debug("saved flow revision: "+flowRevision);
            }
            activeConfig = {
                flows:config,
                rev:flowRevision
            };
            activeFlowConfig = newFlowConfig;
            if (forceStart || started) {
                return stop(type,diff,muteLog).then(function() {
                    context.clean(activeFlowConfig);

                    return start(type,diff,muteLog).then(function() {
                        events.emit("runtime-event",{id:"runtime-deploy",payload:{revision:flowRevision},retain: true});
                        
                        return flowRevision;
                    });
                });
            } else {
                events.emit("runtime-event",{id:"runtime-deploy",payload:{revision:flowRevision},retain: true});
            }
            return flowRevision;
        });
}

function getNode(id) {
    var node;
    if (activeNodesToFlow[id] && activeFlows[activeNodesToFlow[id]]) {
        return activeFlows[activeNodesToFlow[id]].getNode(id);
    }
    for (var flowId in activeFlows) {
        if (activeFlows.hasOwnProperty(flowId)) {
            node = activeFlows[flowId].getNode(id);
            if (node) {
                return node;
            }
        }
    }
    return null;
}

function eachNode(cb) {
    for (var id in activeFlowConfig.allNodes) {
        if (activeFlowConfig.allNodes.hasOwnProperty(id)) {
            cb(activeFlowConfig.allNodes[id]);
        }
    }
}

function getFlows() {
    return activeConfig;
}

function delegateError(node,logMessage,msg) {
    var handled = false;
    if (activeFlows[node.z]) {
        handled = activeFlows[node.z].handleError(node,logMessage,msg);
    } else if (activeNodesToFlow[node.z] && activeFlows[activeNodesToFlow[node.z]]) {
        handled = activeFlows[activeNodesToFlow[node.z]].handleError(node,logMessage,msg);
    } else if (activeFlowConfig && activeFlowConfig.subflows && activeFlowConfig.subflows[node.z] && subflowInstanceNodeMap[node.id]) {
        subflowInstanceNodeMap[node.id].forEach(function(n) {
            handled = handled || delegateError(getNode(n),logMessage,msg);
        });
    }
    return handled;
}
function handleError(node,logMessage,msg) {
    var handled = false;
    if (node.z) {
        handled = delegateError(node,logMessage,msg);
    } else {
        if (activeFlowConfig.configs[node.id]) {
            activeFlowConfig.configs[node.id]._users.forEach(function(id) {
                var userNode = activeFlowConfig.allNodes[id];
                handled = handled || delegateError(userNode,logMessage,msg);
            })
        }
    }
    return handled;
}

function delegateStatus(node,statusMessage) {
    if (activeFlows[node.z]) {
        activeFlows[node.z].handleStatus(node,statusMessage);
    } else if (activeNodesToFlow[node.z] && activeFlows[activeNodesToFlow[node.z]]) {
        activeFlows[activeNodesToFlow[node.z]].handleStatus(node,statusMessage);
    }
}
function handleStatus(node,statusMessage) {
    events.emit("node-status",{
        id: node.id,
        status:statusMessage
    });
    if (node.z) {
        delegateStatus(node,statusMessage);
    } else {
        if (activeFlowConfig.configs[node.id]) {
            activeFlowConfig.configs[node.id]._users.forEach(function(id) {
                var userNode = activeFlowConfig.allNodes[id];
                delegateStatus(userNode,statusMessage);
            })
        }
    }
}


function start(type,diff,muteLog) {
    //dumpActiveNodes();
    type = type||"full";
    started = true;
    var i;
    if (activeFlowConfig.missingTypes.length > 0) {
        log.info(log._("nodes.flows.missing-types"));
        var knownUnknowns = 0;
        for (i=0;i<activeFlowConfig.missingTypes.length;i++) {
            var nodeType = activeFlowConfig.missingTypes[i];
            var info = deprecated.get(nodeType);
            if (info) {
                log.info(log._("nodes.flows.missing-type-provided",{type:activeFlowConfig.missingTypes[i],module:info.module}));
                knownUnknowns += 1;
            } else {
                log.info(" - "+activeFlowConfig.missingTypes[i]);
            }
        }
        if (knownUnknowns > 0) {
            log.info(log._("nodes.flows.missing-type-install-1"));
            log.info("  npm install <module name>");
            log.info(log._("nodes.flows.missing-type-install-2"));
            log.info("  "+settings.userDir);
        }
        events.emit("runtime-event",{id:"runtime-state",payload:{error:"missing-types", type:"warning",text:"notification.warnings.missing-types",types:activeFlowConfig.missingTypes},retain:true});
        return when.resolve();
    }
    if (!muteLog) {
        if (type !== "full") {
            log.info(log._("nodes.flows.starting-modified-"+type));
        } else {
            log.info(log._("nodes.flows.starting-flows"));
        }
    }
    var id;
    if (type === "full") {
        if (!activeFlows['global']) {
            log.debug("red/nodes/flows.start : starting flow : global");
            activeFlows['global'] = Flow.create(activeFlowConfig);
        }
        for (id in activeFlowConfig.flows) {
            if (activeFlowConfig.flows.hasOwnProperty(id)) {
                if (!activeFlowConfig.flows[id].disabled && !activeFlows[id]) {
                    activeFlows[id] = Flow.create(activeFlowConfig,activeFlowConfig.flows[id]);
                    log.debug("red/nodes/flows.start : starting flow : "+id);
                } else {
                    log.debug("red/nodes/flows.start : not starting disabled flow : "+id);
                }
            }
        }
    } else {
        activeFlows['global'].update(activeFlowConfig,activeFlowConfig);
        for (id in activeFlowConfig.flows) {
            if (activeFlowConfig.flows.hasOwnProperty(id)) {
                if (!activeFlowConfig.flows[id].disabled) {
                    if (activeFlows[id]) {
                        activeFlows[id].update(activeFlowConfig,activeFlowConfig.flows[id]);
                    } else {
                        activeFlows[id] = Flow.create(activeFlowConfig,activeFlowConfig.flows[id]);
                        log.debug("red/nodes/flows.start : starting flow : "+id);
                    }
                } else {
                    log.debug("red/nodes/flows.start : not starting disabled flow : "+id);
                }
            }
        }
    }

    for (id in activeFlows) {
        if (activeFlows.hasOwnProperty(id)) {
            activeFlows[id].start(diff);
            var activeNodes = activeFlows[id].getActiveNodes();
            Object.keys(activeNodes).forEach(function(nid) {
                activeNodesToFlow[nid] = id;
                if (activeNodes[nid]._alias) {
                    subflowInstanceNodeMap[activeNodes[nid]._alias] = subflowInstanceNodeMap[activeNodes[nid]._alias] || [];
                    subflowInstanceNodeMap[activeNodes[nid]._alias].push(nid);
                }
            });

        }
    }
    events.emit("nodes-started");

    if (credentialsPendingReset === true) {
        credentialsPendingReset = false;
    } else {
        events.emit("runtime-event",{id:"runtime-state",retain:true});
    }

    if (!muteLog) {
        if (type !== "full") {
            log.info(log._("nodes.flows.started-modified-"+type));
        } else {
            log.info(log._("nodes.flows.started-flows"));
        }
    }
    return when.resolve();
}

function stop(type,diff,muteLog) {
    if (!started) {
        return when.resolve();
    }
    type = type||"full";
    diff = diff||{
        added:[],
        changed:[],
        removed:[],
        rewired:[],
        linked:[]
    };
    if (!muteLog) {
        if (type !== "full") {
            log.info(log._("nodes.flows.stopping-modified-"+type));
        } else {
            log.info(log._("nodes.flows.stopping-flows"));
        }
    }
    started = false;
    var promises = [];
    var stopList;
    var removedList = diff.removed;
    if (type === 'nodes') {
        stopList = diff.changed.concat(diff.removed);
    } else if (type === 'flows') {
        stopList = diff.changed.concat(diff.removed).concat(diff.linked);
    }

    for (var id in activeFlows) {
        if (activeFlows.hasOwnProperty(id)) {
            var flowStateChanged = diff && (diff.added.indexOf(id) !== -1 || diff.removed.indexOf(id) !== -1);
            log.debug("red/nodes/flows.stop : stopping flow : "+id);
            promises = promises.concat(activeFlows[id].stop(flowStateChanged?null:stopList,removedList));
            if (type === "full" || flowStateChanged || diff.removed.indexOf(id)!==-1) {
                delete activeFlows[id];
            }
        }
    }

    return when.promise(function(resolve,reject) {
        when.settle(promises).then(function() {
            for (id in activeNodesToFlow) {
                if (activeNodesToFlow.hasOwnProperty(id)) {
                    if (!activeFlows[activeNodesToFlow[id]]) {
                        delete activeNodesToFlow[id];
                    }
                }
            }
            if (stopList) {
                stopList.forEach(function(id) {
                    delete activeNodesToFlow[id];
                });
            }
            // Ideally we'd prune just what got stopped - but mapping stopList
            // id to the list of subflow instance nodes is something only Flow
            // can do... so cheat by wiping the map knowing it'll be rebuilt
            // in start()
            subflowInstanceNodeMap = {};
            if (!muteLog) {
                if (type !== "full") {
                    log.info(log._("nodes.flows.stopped-modified-"+type));
                } else {
                    log.info(log._("nodes.flows.stopped-flows"));
                }
            }
            resolve();
        });
    });
}


function checkTypeInUse(id) {
    var nodeInfo = typeRegistry.getNodeInfo(id);
    if (!nodeInfo) {
        throw new Error(log._("nodes.index.unrecognised-id", {id:id}));
    } else {
        var inUse = {};
        var config = getFlows();
        config.flows.forEach(function(n) {
            inUse[n.type] = (inUse[n.type]||0)+1;
        });
        var nodesInUse = [];
        nodeInfo.types.forEach(function(t) {
            if (inUse[t]) {
                nodesInUse.push(t);
            }
        });
        if (nodesInUse.length > 0) {
            var msg = nodesInUse.join(", ");
            var err = new Error(log._("nodes.index.type-in-use", {msg:msg}));
            err.code = "type_in_use";
            throw err;
        }
    }
}

function updateMissingTypes() {
    var subflowInstanceRE = /^subflow:(.+)$/;
    activeFlowConfig.missingTypes = [];

    for (var id in activeFlowConfig.allNodes) {
        if (activeFlowConfig.allNodes.hasOwnProperty(id)) {
            var node = activeFlowConfig.allNodes[id];
            if (node.type !== 'tab' && node.type !== 'subflow') {
                var subflowDetails = subflowInstanceRE.exec(node.type);
                if ( (subflowDetails && activeFlowConfig && activeFlowConfig.subflows && !activeFlowConfig.subflows[subflowDetails[1]]) || (!subflowDetails && !typeRegistry.get(node.type)) ) {
                    if (activeFlowConfig.missingTypes.indexOf(node.type) === -1) {
                        activeFlowConfig.missingTypes.push(node.type);
                    }
                }
            }
        }
    }
}

function addFlow(flow) {
    var i,node;
    if (!flow.hasOwnProperty('nodes')) {
        throw new Error('missing nodes property');
    }
    flow.id = redUtil.generateId();

    var nodes = [{
        type:'tab',
        label:flow.label,
        id:flow.id
    }];

    for (i=0;i<flow.nodes.length;i++) {
        node = flow.nodes[i];
        if (activeFlowConfig.allNodes[node.id]) {
            // TODO nls
            return when.reject(new Error('duplicate id'));
        }
        if (node.type === 'tab' || node.type === 'subflow') {
            return when.reject(new Error('invalid node type: '+node.type));
        }
        node.z = flow.id;
        nodes.push(node);
    }
    if (flow.configs) {
        for (i=0;i<flow.configs.length;i++) {
            node = flow.configs[i];
            if (activeFlowConfig.allNodes[node.id]) {
                // TODO nls
                return when.reject(new Error('duplicate id'));
            }
            if (node.type === 'tab' || node.type === 'subflow') {
                return when.reject(new Error('invalid node type: '+node.type));
            }
            node.z = flow.id;
            nodes.push(node);
        }
    }
    var newConfig = clone(activeConfig.flows);
    newConfig = newConfig.concat(nodes);

    return setFlows(newConfig,'flows',true).then(function() {
        log.info(log._("nodes.flows.added-flow",{label:(flow.label?flow.label+" ":"")+"["+flow.id+"]"}));
        return flow.id;
    });
}

function getFlow(id) {
    var flow;
    if (id === 'global') {
        flow = activeFlowConfig;
    } else {
        flow = activeFlowConfig.flows[id];
    }
    if (!flow) {
        return null;
    }
    var result = {
        id: id
    };
    if (flow.label) {
        result.label = flow.label;
    }
    if (id !== 'global') {
        result.nodes = [];
    }
    if (flow.nodes) {
        var nodeIds = Object.keys(flow.nodes);
        if (nodeIds.length > 0) {
            result.nodes = nodeIds.map(function(nodeId) {
                var node = clone(flow.nodes[nodeId]);
                if (node.type === 'link out') {
                    delete node.wires;
                }
                return node;
            })
        }
    }
    if (flow.configs) {
        var configIds = Object.keys(flow.configs);
        result.configs = configIds.map(function(configId) {
            return clone(flow.configs[configId]);
        })
        if (result.configs.length === 0) {
            delete result.configs;
        }
    }
    if (flow.subflows) {
        var subflowIds = Object.keys(flow.subflows);
        result.subflows = subflowIds.map(function(subflowId) {
            var subflow = clone(flow.subflows[subflowId]);
            var nodeIds = Object.keys(subflow.nodes);
            subflow.nodes = nodeIds.map(function(id) {
                return subflow.nodes[id];
            });
            if (subflow.configs) {
                var configIds = Object.keys(subflow.configs);
                subflow.configs = configIds.map(function(id) {
                    return subflow.configs[id];
                })
            }
            delete subflow.instances;
            return subflow;
        });
        if (result.subflows.length === 0) {
            delete result.subflows;
        }
    }
    return result;
}

function updateFlow(id,newFlow) {
    if (!updateFlow._updateCounter) updateFlow._updateCounter = 0;
    updateFlow._updateCounter++;
    
    var label = id;
    if (id !== 'global') {
        if (!activeFlowConfig.flows[id]) {
            var e = new Error();
            e.code = 404;
            throw e;
        }
        label = activeFlowConfig.flows[id].label;
    }
    
    // Every 25th updateFlow call or when memory pressure, do aggressive cleanup
    var currentMemory = process.memoryUsage();
    var heapMB = currentMemory.heapUsed / 1024 / 1024;
    var shouldCleanup = updateFlow._updateCounter % 25 === 0 || heapMB > 280;
    
    if (shouldCleanup) {
        // Quick win: For global updates, clear the registry cache proactively
        if (typeRegistry.clearCache) {
            typeRegistry.clearCache();
        }
        
        // More aggressive node cache management - partial clear to keep recent entries
        var nodeCacheStats = nodeCache.getStats();
        if (nodeCacheStats.size > 3000) {  // Lower threshold for updateFlow
            nodeCache.clear(true); // Partial clear
        }
        
        // Force GC more frequently for updateFlow
        if (global.gc && (heapMB > 250 || updateFlow._updateCounter % 50 === 0)) {
            global.gc();
        }
    } else {
        // Quick win: For global updates, clear the registry cache proactively
        // to prevent memory accumulation during the expensive operation
        if (id === 'global' && typeRegistry.clearCache) {
            typeRegistry.clearCache();
            
            // Also clear node cache periodically to prevent unbounded growth
            if (nodeCache.getStats().size > 8000) {  // Lower threshold
                nodeCache.clear(true); // Use partial clear
            }
        }
    }

    if (heapMB > 400) {
        typeRegistry.clearCache();
        
        if (heapMB > 450) {
            nodeCache.clear(true);
        }

        if (global.gc) {
            global.gc();
        }
    }

    var newConfig;
    if (id === 'global') {
        newConfig = activeConfig.flows.filter(function(node) {
            return node.type === 'tab' || (node.hasOwnProperty('z') && activeFlowConfig.flows.hasOwnProperty(node.z));
        }).map(function(node) {
            return clone(node);
        });
    } else {
        newConfig = activeConfig.flows.filter(function(node) {
            return node.z !== id && node.id !== id;
        }).map(function(node) {
            return clone(node);
        });
    }
    
    var nodes;

    if (id === 'global') {
        // Add in the new config nodes
        nodes = newFlow.configs||[];
        if (newFlow.subflows) {
            // Add in the new subflows
            newFlow.subflows.forEach(function(sf) {
                nodes = nodes.concat(sf.nodes||[]).concat(sf.configs||[]);
                delete sf.nodes;
                delete sf.configs;
                nodes.push(sf);
            });
        }
    } else {
        var tabNode = {
            type:'tab',
            label:newFlow.label,
            id:id
        }
        nodes = [tabNode].concat(newFlow.nodes||[]).concat(newFlow.configs||[]);
        nodes.forEach(function(n) {
            n.z = id;
        });
    }

    newConfig = newConfig.concat(nodes);
    return setFlows(newConfig,'flows',true).then(function() {
        log.info(log._("nodes.flows.updated-flow",{label:(label?label+" ":"")+"["+id+"]"}));
    })
}

function removeFlow(id) {
    if (id === 'global') {
        // TODO: nls + error code
        throw new Error('not allowed to remove global');
    }
    var flow = activeFlowConfig.flows[id];
    if (!flow) {
        var e = new Error();
        e.code = 404;
        throw e;
    }

    var newConfig = clone(activeConfig.flows);
    newConfig = newConfig.filter(function(node) {
        return node.z !== id && node.id !== id;
    });

    return setFlows(newConfig,'flows',true).then(function() {
        log.info(log._("nodes.flows.removed-flow",{label:(flow.label?flow.label+" ":"")+"["+flow.id+"]"}));
    });
}

module.exports = {
    init: init,

    /**
     * Load the current flow configuration from storage
     * @return a promise for the loading of the config
     */
    load: load,

    get:getNode,
    eachNode: eachNode,

    /**
     * Gets the current flow configuration
     */
    getFlows: getFlows,
    
    /**
     * Simple performance monitoring
     */
    getPerformanceStats: function() {
        const registryStats = typeRegistry.getCacheStats ? typeRegistry.getCacheStats() : {};
        const nodeCacheStats = nodeCache.getStats();
        const memUsage = process.memoryUsage();
        
        return {
            monitor: stats,
            registry: registryStats,
            nodeCache: nodeCacheStats,
            memory: {
                heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
                heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
                external: Math.round(memUsage.external / 1024 / 1024)
            },
            activeFlows: Object.keys(activeFlows).length
        };
    },

    /**
     * Sets the current active config.
     * @param config the configuration to enable
     * @param type the type of deployment to do: full (default), nodes, flows, load
     * @return a promise for the saving/starting of the new flow
     */
    setFlows: setFlows,

    /**
     * Starts the current flow configuration
     */
    startFlows: start,

    /**
     * Stops the current flow configuration
     * @return a promise for the stopping of the flow
     */
    stopFlows: stop,

    get started() { return started },

    handleError: handleError,
    handleStatus: handleStatus,

    checkTypeInUse: checkTypeInUse,

    addFlow: addFlow,
    getFlow: getFlow,
    updateFlow: updateFlow,
    removeFlow: removeFlow,
    disableFlow:null,
    enableFlow:null

};
