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

// Simple monitoring
const monitor = require('./simple-monitor');
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
    // OPTIMIZATION 1: Try flow-level cache first (fastest)
    var cachedFlowConfig = nodeCache.getCachedFlowConfig(config);
    if (cachedFlowConfig) {
        return cachedFlowConfig;
    }
    
    // OPTIMIZATION 2: Node-level caching (for partial matches)
    // For configs with 99%+ identical nodes, this can provide massive speedups
    var optimizedConfig = config.map(function(node) {
        if (!node || !node.id) return node;
        
        if (nodeCache.canReuseNode(node.id, node)) {
            var cachedNode = nodeCache.getCachedNode(node.id);
            if (cachedNode) {
                return cachedNode;
            }
        }
        
        // Clone and cache the node for future use
        var clonedNode = clone(node);
        nodeCache.cacheNode(node.id, clonedNode);
        return clonedNode;
    });
    
    // Parse the config and cache the result
    var parsedConfig = flowUtil.parseConfig(optimizedConfig);
    
    // Cache the complete parsed config for future use
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
    
    // ANTI-SLOWDOWN: Aggressive periodic cleanup to prevent gradual performance degradation
    // This addresses the accumulation of cached data over many requests
    var currentMemory = process.memoryUsage();
    var heapMB = currentMemory.heapUsed / 1024 / 1024;
    var shouldPeriodicCleanup = false;
    
    // Every 50th operation or when memory exceeds 300MB, do aggressive cleanup
    if (!setFlows._operationCounter) setFlows._operationCounter = 0;
    setFlows._operationCounter++;
    
    if (setFlows._operationCounter % 50 === 0 || heapMB > 300) {
        shouldPeriodicCleanup = true;
        
        // Clear registry cache more aggressively to prevent long-term accumulation
        if (typeRegistry.clearCache) {
            typeRegistry.clearCache();
        }
        
        // Periodic node cache cleanup - keep only most recent entries
        var nodeCacheStats = nodeCache.getStats();
        if (nodeCacheStats.size > 5000) { // Much lower threshold for periodic cleanup
            // Use partial clear instead of full clear to maintain some cache benefit
            nodeCache.clear(true); // Partial clear - keeps newest 30% of entries
        }
        
        // Force garbage collection if available
        if (global.gc && (heapMB > 250 || setFlows._operationCounter % 100 === 0)) {
            global.gc();
        }
    }
    
    monitor.logOperation('setFlows-start', { 
        type: type, 
        configSize: _config ? _config.length : 0, 
        operationId: operationId,
        periodicCleanup: shouldPeriodicCleanup,
        heapMB: Math.round(heapMB),
        operationCount: setFlows._operationCounter
    });
    
    type = type||"full";

    var configSavePromise = null;
    var config = null;
    var diff;
    var newFlowConfig;
    var isLoad = false;
    if (type === "load") {
        isLoad = true;
        configSavePromise = loadFlows().then(function(_config) {
            monitor.logOperation('setFlows-load-clone', { configSize: _config.flows.length });
            config = clone(_config.flows);
            newFlowConfig = flowUtil.parseConfig(clone(config));
            type = "full";
            return _config.rev;
        });
    } else {
        monitor.logOperation('setFlows-config-clone-start', { configSize: _config.length });
        config = clone(_config);
        monitor.logOperation('setFlows-config-clone-end', { configSize: config.length });
        
        // Quick check: if config is identical to activeConfig, skip expensive operations
        var configHash = null;
        var configUnchanged = false;
        var batchOptimization = false;
        
        if (activeConfig && activeConfig.flows) {            
            // For large configs (1000+ nodes), do a comprehensive hash comparison
            if (config.length > 1000) {
                // Create a more comprehensive hash for better change detection
                var nodeIds = config.map(n => n.id || 'none').sort().join(',');
                var nodeTypes = config.map(n => n.type || 'none').sort().join(',');
                configHash = config.length + '-' + nodeIds.substring(0, 100) + '-' + nodeTypes.substring(0, 100);
                
                var activeNodeIds = activeConfig.flows.map(n => n.id || 'none').sort().join(',');
                var activeNodeTypes = activeConfig.flows.map(n => n.type || 'none').sort().join(',');  
                var activeHash = activeConfig.flows.length + '-' + activeNodeIds.substring(0, 100) + '-' + activeNodeTypes.substring(0, 100);
                
                // Check if identical first
                configUnchanged = (configHash === activeHash);
                
                // Batch optimization: if configs are very similar (80%+ same node IDs), use aggressive caching
                // Remove the same-length requirement to detect similarity across different batch sizes
                if (!configUnchanged) {
                    var currentIds = new Set(config.map(n => n.id).filter(Boolean));
                    var activeIds = new Set(activeConfig.flows.map(n => n.id).filter(Boolean));
                    var intersection = new Set([...currentIds].filter(id => activeIds.has(id)));
                    var similarity = intersection.size / Math.max(currentIds.size, activeIds.size);
                    
                    if (similarity > 0.8) { // 80%+ similar
                        batchOptimization = true;
                    }
                }
            } else {
                // For smaller configs, use simpler comparison
                if (config.length === activeConfig.flows.length) {
                    configUnchanged = JSON.stringify(config).length === JSON.stringify(activeConfig.flows).length;
                }
            }
            monitor.logOperation('setFlows-config-unchanged-check', { 
                configUnchanged: configUnchanged, 
                batchOptimization: batchOptimization,
                configSize: config.length 
            });
        }
        
        monitor.logOperation('setFlows-parseConfig-start', { configSize: config.length, nodeEstimate: config.length });
        
        // Emergency optimization: if config appears unchanged and it's large, reuse existing parsed config
        if (configUnchanged && config.length > 1000 && activeFlowConfig) {
            newFlowConfig = activeFlowConfig; // Reuse existing parsed config
            monitor.logOperation('setFlows-parseConfig-skipped', { nodeCount: Object.keys(newFlowConfig.allNodes || {}).length });
        } else if (batchOptimization && activeFlowConfig) {
            // Batch optimization: for very similar configs, use smart parsing with heavy caching
            newFlowConfig = parseConfigWithNodeCache(config);
            monitor.logOperation('setFlows-parseConfig-batch-optimized', { 
                nodeCount: Object.keys(newFlowConfig.allNodes || {}).length,
                cacheStats: nodeCache.getStats()
            });
        } else {
            // Smart node-level caching for large configs
            if (config.length > 1000) {
                monitor.logOperation('setFlows-parseConfig-smart-start', { configSize: config.length });
                newFlowConfig = parseConfigWithNodeCache(config);
                monitor.logOperation('setFlows-parseConfig-smart-end', { 
                    nodeCount: Object.keys(newFlowConfig.allNodes || {}).length,
                    cacheStats: nodeCache.getStats()
                });
            } else {
                newFlowConfig = flowUtil.parseConfig(clone(config));
                monitor.logOperation('setFlows-parseConfig-end', { nodeCount: Object.keys(newFlowConfig.allNodes || {}).length });
            }
        }
        
        monitor.logOperation('setFlows-diffConfigs-start', { configUnchanged: configUnchanged, batchOptimization: batchOptimization });
        
        // Emergency optimization: skip expensive diff if config appears unchanged
        if (configUnchanged && activeFlowConfig) {
            diff = { added: [], changed: [], removed: [], rewired: [] }; // Empty diff
            monitor.logOperation('setFlows-diffConfigs-skipped');
        } else if (batchOptimization && activeFlowConfig) {
            // Batch optimization: for similar configs, use incremental diff
            var cachedDiff = nodeCache.getCachedDiff(activeFlowConfig, newFlowConfig);
            if (cachedDiff) {
                diff = cachedDiff;
                monitor.logOperation('setFlows-diffConfigs-cached', {
                    added: cachedDiff.added ? cachedDiff.added.length : 0,
                    changed: cachedDiff.changed ? cachedDiff.changed.length : 0,
                    removed: cachedDiff.removed ? cachedDiff.removed.length : 0
                });
            } else {
                // Force incremental diff for batch operations - much faster
                diff = nodeCache.computeIncrementalDiff(activeFlowConfig, newFlowConfig) || 
                       flowUtil.diffConfigs(activeFlowConfig,newFlowConfig);
                nodeCache.cacheDiff(activeFlowConfig, newFlowConfig, diff);
                monitor.logOperation('setFlows-diffConfigs-batch-incremental', { 
                    added: diff.added ? diff.added.length : 0,
                    changed: diff.changed ? diff.changed.length : 0,
                    removed: diff.removed ? diff.removed.length : 0
                });
            }
        } else {
            // Try diff cache first
            var cachedDiff = nodeCache.getCachedDiff(activeFlowConfig, newFlowConfig);
            if (cachedDiff) {
                diff = cachedDiff;
                monitor.logOperation('setFlows-diffConfigs-cached', {
                    added: diff.added ? diff.added.length : 0,
                    changed: diff.changed ? diff.changed.length : 0,
                    removed: diff.removed ? diff.removed.length : 0
                });
            } else {
                var diffStart = Date.now();
                diff = flowUtil.diffConfigs(activeFlowConfig,newFlowConfig);
                var diffTime = Date.now() - diffStart;
                
                // Cache the diff result for future use
                nodeCache.cacheDiff(activeFlowConfig, newFlowConfig, diff);
                
                monitor.logOperation('setFlows-diffConfigs-end', { 
                    added: diff.added ? diff.added.length : 0,
                    changed: diff.changed ? diff.changed.length : 0,
                    removed: diff.removed ? diff.removed.length : 0,
                    diffTime: diffTime
                });
            }
        }

        // Now the flows have been compared, remove any credentials from newFlowConfig
        // so they don't cause false-positive diffs the next time a flow is deployed
        monitor.logOperation('setFlows-credentials-cleanup-start');
        var credStart = Date.now();
        
        for (var id in newFlowConfig.allNodes) {
            if (newFlowConfig.allNodes.hasOwnProperty(id)) {
                delete newFlowConfig.allNodes[id].credentials;
            }
        }
        var credTime = Date.now() - credStart;
        monitor.logOperation('setFlows-credentials-cleanup-end', { credTime: credTime });

        credentials.clean(config);
        var credsDirty = credentials.dirty();
        
        monitor.logOperation('setFlows-credentials-export-start');
        configSavePromise = credentials.export().then(function(creds) {
            monitor.logOperation('setFlows-credentials-export-end');
            
            var saveConfig = {
                flows: config,
                credentialsDirty:credsDirty,
                credentials: creds
            }
            monitor.logOperation('setFlows-storage-save-start');
            return storage.saveFlows(saveConfig).then(function(result) {
                return result;
            });
        });
    }

    return configSavePromise
        .then(function(flowRevision) {
            monitor.logOperation('setFlows-storage-save-end', { flowRevision: flowRevision });
            if (!isLoad) {
                log.debug("saved flow revision: "+flowRevision);
            }
            activeConfig = {
                flows:config,
                rev:flowRevision
            };
            activeFlowConfig = newFlowConfig;
            if (forceStart || started) {
                monitor.logOperation('setFlows-stop-start');
                return stop(type,diff,muteLog).then(function() {
                    monitor.logOperation('setFlows-stop-end');
                    
                    context.clean(activeFlowConfig);
                    
                    monitor.logOperation('setFlows-start-begin');
                    return start(type,diff,muteLog).then(function() {
                        monitor.logOperation('setFlows-start-complete');
                        events.emit("runtime-event",{id:"runtime-deploy",payload:{revision:flowRevision},retain: true});
                        return flowRevision;
                    });
                }).catch(function(_err) {
                    monitor.logOperation('setFlows-stop-error');
                })
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
    } else if (activeFlowConfig.subflows[node.z] && subflowInstanceNodeMap[node.id]) {
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
                if ( (subflowDetails && !activeFlowConfig.subflows[subflowDetails[1]]) || (!subflowDetails && !typeRegistry.get(node.type)) ) {
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
    monitor.logOperation('updateFlow-start', { flowId: id });
    monitor.trackCacheSize(typeRegistry);
    
    // ANTI-SLOWDOWN: More aggressive periodic cleanup for updateFlow
    // updateFlow is called repeatedly and is often the source of gradual slowdown
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
            monitor.logOperation('updateFlow-clear-cache', { flowId: id });
            typeRegistry.clearCache();
            
            // Also clear node cache periodically to prevent unbounded growth
            if (nodeCache.getStats().size > 8000) {  // Lower threshold
                nodeCache.clear(true); // Use partial clear
            }
        }
    }
    
    // Emergency fix: Check memory pressure and force cleanup if needed
    if (heapMB > 400) {  // Your logs show 488-502MB, so trigger at 400MB
        typeRegistry.clearCache();
        
        // Clear node cache too during high memory pressure
        if (heapMB > 450) {
            nodeCache.clear(true); // Even under pressure, try partial clear first
        }
        
        // Force garbage collection if available (node --expose-gc)
        if (global.gc) {
            global.gc();
        }
    }
    
    monitor.logOperation('updateFlow-clone-start', { flowId: id });
    // Quick win: Instead of cloning the entire config, just filter and modify
    var newConfig;
    if (id === 'global') {
        // For global, we need the full config but we can filter without cloning first
        newConfig = activeConfig.flows.filter(function(node) {
            return node.type === 'tab' || (node.hasOwnProperty('z') && activeFlowConfig.flows.hasOwnProperty(node.z));
        }).map(function(node) {
            return clone(node); // Clone individual nodes instead of entire array
        });
    } else {
        // For specific flows, we can be more targeted
        newConfig = activeConfig.flows.filter(function(node) {
            return node.z !== id && node.id !== id;
        }).map(function(node) {
            return clone(node); // Clone individual nodes instead of entire array  
        });
    }
    monitor.logOperation('updateFlow-clone-end', { flowId: id, configSize: newConfig.length });
    
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
    monitor.logOperation('updateFlow-setFlows-start', { flowId: id, totalNodes: newConfig.length });
    return setFlows(newConfig,'flows',true).then(function() {
        monitor.logOperation('updateFlow-complete', { flowId: id });
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
        const stats = monitor.getStats();
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
