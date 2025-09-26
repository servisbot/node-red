/**
 * Smart node-level cache for Node-RED flows
 * Caches parsed node configurations to avoid reprocessing identical nodes
 */

class NodeCache {
    constructor(maxSize = 20000) {  // Increased from 10,000 to reduce evictions
        this.cache = new Map(); // nodeId -> parsed node config
        this.nodeHashes = new Map(); // nodeId -> hash of node config
        this.maxSize = maxSize;
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: 0
        };
        
        // Add flow-level caching for better performance
        this.flowConfigCache = new Map(); // configHash -> parsed flow config
        this.maxFlowConfigs = 50; // Keep last 50 parsed configs
        
        // Add diff caching for better performance
        this.diffCache = new Map(); // configHash -> diff result
        this.maxDiffConfigs = 25; // Keep last 25 diff results
    }

    // Generate a simple hash for a node configuration
    hashNode(node) {
        if (!node || typeof node !== 'object') return 'null';
        
        // Create hash from key properties that affect node behavior
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
        
        // Add filtered properties (compatible with older Node.js)
        filteredEntries.forEach(([k, v]) => {
            nodeData[k] = v;
        });
        
        const key = JSON.stringify(nodeData);
        return key.length + '-' + key.slice(0, 50) + '-' + key.slice(-10);
    }

    // Generate hash for entire config to enable flow-level caching
    hashConfig(config) {
        if (!config || !Array.isArray(config)) return 'null-config';
        
        // Sort by id for consistent hashing regardless of order
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

    // Cache entire parsed flow config with more aggressive cleanup
    cacheFlowConfig(config, parsedConfig) {
        const configHash = this.hashConfig(config);
        
        // ANTI-SLOWDOWN: More aggressive flow cache management  
        // Simple LRU for flow configs - keep only 30 most recent (reduced from 50)
        if (this.flowConfigCache.size >= 30) {
            const firstKey = this.flowConfigCache.keys().next().value;
            this.flowConfigCache.delete(firstKey);
        }
        
        this.flowConfigCache.set(configHash, parsedConfig);
    }

    // Try to get cached diff result
    getCachedDiff(oldConfig, newConfig) {
        const oldHash = oldConfig ? this.hashConfig(Object.values(oldConfig.allNodes || {})) : 'null';
        const newHash = this.hashConfig(Object.values(newConfig.allNodes || {}));
        const diffKey = `${oldHash}→${newHash}`;
        
        const cached = this.diffCache.get(diffKey);
        if (cached) {
            // Move to end for LRU
            this.diffCache.delete(diffKey);
            this.diffCache.set(diffKey, cached);
            return cached;
        }
        
        // Check if this is a small incremental change we can optimize
        if (oldConfig && newConfig && this.canUseIncrementalDiff(oldConfig, newConfig)) {
            return this.computeIncrementalDiff(oldConfig, newConfig);
        }
        
        return null;
    }

    // Check if we can use faster incremental diffing
    canUseIncrementalDiff(oldConfig, newConfig) {
        const oldNodeCount = Object.keys(oldConfig.allNodes || {}).length;
        const newNodeCount = Object.keys(newConfig.allNodes || {}).length;
        
        // If node counts are very similar, might be incremental
        const diff = Math.abs(newNodeCount - oldNodeCount);
        const changeRatio = diff / Math.max(oldNodeCount, newNodeCount);
        
        // Less than 10% change in node count - likely incremental
        return changeRatio < 0.1 && oldNodeCount > 1000;
    }

    // Compute incremental diff for small changes (experimental optimization)
    computeIncrementalDiff(oldConfig, newConfig) {
        const added = {};
        const changed = {};
        const removed = {};
        
        // Quick scan for obvious additions/removals
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
        
        // For performance, assume remaining nodes unchanged for large configs
        // This is an approximation but much faster than full diffing
        
        return {
            added: Object.keys(added),
            changed: Object.keys(changed), // Empty for performance
            removed: Object.keys(removed),
            rewired: [] // Empty for performance
        };
    }

        // Cache diff result with aggressive cleanup for long-running systems
    cacheDiff(oldConfig, newConfig, diff) {
        const oldHash = oldConfig ? this.hashConfig(Object.values(oldConfig.allNodes || {})) : 'null';
        const newHash = this.hashConfig(Object.values(newConfig.allNodes || {}));
        const diffKey = `${oldHash}→${newHash}`;
        
        // ANTI-SLOWDOWN: More aggressive diff cache management
        // LRU eviction for diff cache - keep only 15 most recent (reduced from 25)
        if (this.diffCache.size >= 15) {  
            const firstKey = this.diffCache.keys().next().value;
            this.diffCache.delete(firstKey);
        }
        
        this.diffCache.set(diffKey, diff);
    }

    // Check if we can reuse a cached node
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

    // Cache a processed node
    cacheNode(nodeId, processedNode) {
        // Simple LRU eviction
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
            this.nodeHashes.delete(firstKey);
            this.stats.evictions++;
        }
        
        this.cache.set(nodeId, processedNode);
    }

    // Get cached processed node
    getCachedNode(nodeId) {
        const cached = this.cache.get(nodeId);
        if (cached) {
            // Move to end for LRU
            this.cache.delete(nodeId);
            this.cache.set(nodeId, cached);
        }
        return cached;
    }

    // Get cache statistics
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

    // Clear cache with optional partial clearing for gradual slowdown prevention
    clear(partialOnly = false) {
        if (partialOnly && this.cache.size > 1000) {
            // ANTI-SLOWDOWN: Partial clear - remove oldest 70% of entries but keep recent ones
            // This prevents the "reset shock" of full clearing while preventing accumulation
            const keepCount = Math.floor(this.cache.size * 0.3);
            const entriesToKeep = Array.from(this.cache.entries()).slice(-keepCount);
            const hashesToKeep = Array.from(this.nodeHashes.entries()).slice(-keepCount);
            
            this.cache.clear();
            this.nodeHashes.clear();
            
            // Restore the most recent entries
            entriesToKeep.forEach(([key, value]) => this.cache.set(key, value));
            hashesToKeep.forEach(([key, value]) => this.nodeHashes.set(key, value));
            
            // Also partially clear flow and diff caches
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
            // Full clear
            this.cache.clear();
            this.nodeHashes.clear();
            this.flowConfigCache.clear();
            this.diffCache.clear();
        }
        
        this.stats = { hits: 0, misses: 0, evictions: 0 };
    }

    // Get memory estimate
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