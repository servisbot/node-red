/**
 * Node-level cache
 */

class NodeCache {
    constructor(maxSize = 20000) {
        this.cache = new Map();
        this.nodeHashes = new Map();
        this.maxSize = maxSize;
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: 0
        };
        
        this.flowConfigCache = new Map();
        this.maxFlowConfigs = 50;
        
        this.diffCache = new Map();
        this.maxDiffConfigs = 25;
    }

    hashNode(node) {
        if (!node || typeof node !== 'object') return 'null';
        
        const filteredEntries = [];
        for (const [k, v] of Object.entries(node)) {
            if (!k.match(/^(x|y|w|h|_alias)$/) && v !== undefined) {
                filteredEntries.push([k, v]);
            }
        }
        
        const nodeData = {
            id: node.id,
            type: node.type,
            z: node.z,
        };
        
        filteredEntries.forEach(([k, v]) => {
            nodeData[k] = v;
        });
        
        const key = JSON.stringify(nodeData);
        return key.length + '-' + key.slice(0, 50) + '-' + key.slice(-10);
    }

    // Generate hash for entire config to enable flow-level caching
    hashConfig(config) {
        if (!config || !Array.isArray(config)) return 'null-config';

        const sortedConfig = config
            .filter(n => n && n.id)
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(n => this.hashNode(n));
        
        const configStr = sortedConfig.join('|');
        return `${config.length}-${configStr.length}-${configStr.slice(0, 100)}-${configStr.slice(-50)}`;
    }

    // Try to get cached flow config first (highest performance)
    getCachedFlowConfig(config) {
        const configHash = this.hashConfig(config);
        const cached = this.flowConfigCache.get(configHash);
        
        if (cached) {
            // Move to end for LRU
            this.flowConfigCache.delete(configHash);
            this.flowConfigCache.set(configHash, cached);
            return cached;
        }
        
        return null;
    }

    cacheFlowConfig(config, parsedConfig) {
        const configHash = this.hashConfig(config);

        if (this.flowConfigCache.size >= 30) {
            const firstKey = this.flowConfigCache.keys().next().value;
            this.flowConfigCache.delete(firstKey);
        }
        
        this.flowConfigCache.set(configHash, parsedConfig);
    }

    getCachedDiff(oldConfig, newConfig) {
        const oldHash = oldConfig ? this.hashConfig(Object.values(oldConfig.allNodes || {})) : 'null';
        const newHash = this.hashConfig(Object.values(newConfig.allNodes || {}));
        const diffKey = `${oldHash}→${newHash}`;
        
        const cached = this.diffCache.get(diffKey);
        if (cached) {
            this.diffCache.delete(diffKey);
            this.diffCache.set(diffKey, cached);
            return cached;
        }
        
        if (oldConfig && newConfig && this.canUseIncrementalDiff(oldConfig, newConfig)) {
            return this.computeIncrementalDiff(oldConfig, newConfig);
        }
        
        return null;
    }

    canUseIncrementalDiff(oldConfig, newConfig) {
        const oldNodeCount = Object.keys(oldConfig.allNodes || {}).length;
        const newNodeCount = Object.keys(newConfig.allNodes || {}).length;
        
        const diff = Math.abs(newNodeCount - oldNodeCount);
        const changeRatio = diff / Math.max(oldNodeCount, newNodeCount);

        return changeRatio < 0.1 && oldNodeCount > 1000;
    }

    computeIncrementalDiff(oldConfig, newConfig) {
        const added = {};
        const changed = {};
        const removed = {};

        for (const id in newConfig.allNodes) {
            if (!oldConfig.allNodes[id]) {
                added[id] = newConfig.allNodes[id];
            }
        }
        
        for (const id in oldConfig.allNodes) {
            if (!newConfig.allNodes[id]) {
                removed[id] = oldConfig.allNodes[id];
            }
        }

        return {
            added: Object.keys(added),
            changed: Object.keys(changed),
            removed: Object.keys(removed),
            rewired: []
        };
    }

    cacheDiff(oldConfig, newConfig, diff) {
        const oldHash = oldConfig ? this.hashConfig(Object.values(oldConfig.allNodes || {})) : 'null';
        const newHash = this.hashConfig(Object.values(newConfig.allNodes || {}));
        const diffKey = `${oldHash}→${newHash}`;

        if (this.diffCache.size >= 15) {  
            const firstKey = this.diffCache.keys().next().value;
            this.diffCache.delete(firstKey);
        }
        
        this.diffCache.set(diffKey, diff);
    }

    canReuseNode(nodeId, node) {
        const currentHash = this.hashNode(node);
        const cachedHash = this.nodeHashes.get(nodeId);
        
        if (cachedHash && cachedHash === currentHash) {
            this.stats.hits++;
            return true;
        }
        
        this.stats.misses++;
        this.nodeHashes.set(nodeId, currentHash);
        return false;
    }

    cacheNode(nodeId, processedNode) {
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
            this.nodeHashes.delete(firstKey);
            this.stats.evictions++;
        }
        
        this.cache.set(nodeId, processedNode);
    }

    getCachedNode(nodeId) {
        const cached = this.cache.get(nodeId);
        if (cached) {
            this.cache.delete(nodeId);
            this.cache.set(nodeId, cached);
        }
        return cached;
    }

    getStats() {
        const hitRate = this.stats.hits + this.stats.misses > 0 
            ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(1)
            : 0;
            
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            hitRate: `${hitRate}%`,
            hits: this.stats.hits,
            misses: this.stats.misses,
            evictions: this.stats.evictions
        };
    }

    clear(partialOnly = false) {
        if (partialOnly && this.cache.size > 1000) {
            const keepCount = Math.floor(this.cache.size * 0.3);
            const entriesToKeep = Array.from(this.cache.entries()).slice(-keepCount);
            const hashesToKeep = Array.from(this.nodeHashes.entries()).slice(-keepCount);
            
            this.cache.clear();
            this.nodeHashes.clear();

            entriesToKeep.forEach(([key, value]) => this.cache.set(key, value));
            hashesToKeep.forEach(([key, value]) => this.nodeHashes.set(key, value));

            if (this.flowConfigCache.size > 15) {
                const flowKeepCount = Math.floor(this.flowConfigCache.size * 0.4);
                const flowEntries = Array.from(this.flowConfigCache.entries()).slice(-flowKeepCount);
                this.flowConfigCache.clear();
                flowEntries.forEach(([key, value]) => this.flowConfigCache.set(key, value));
            }
            
            if (this.diffCache.size > 8) {
                const diffKeepCount = Math.floor(this.diffCache.size * 0.4);
                const diffEntries = Array.from(this.diffCache.entries()).slice(-diffKeepCount);
                this.diffCache.clear();
                diffEntries.forEach(([key, value]) => this.diffCache.set(key, value));
            }
        } else {
            this.cache.clear();
            this.nodeHashes.clear();
            this.flowConfigCache.clear();
            this.diffCache.clear();
        }
        
        this.stats = { hits: 0, misses: 0, evictions: 0 };
    }

    getMemoryEstimate() {
        const nodesMB = Math.round((this.cache.size * 500) / 1024);
        const flowsMB = Math.round((this.flowConfigCache.size * 50) / 1024);
        const diffMB = Math.round((this.diffCache.size * 10) / 1024); 
        return { 
            nodes: nodesMB, 
            flows: flowsMB, 
            diffs: diffMB,
            total: nodesMB + flowsMB + diffMB 
        };
    }
}

module.exports = new NodeCache();