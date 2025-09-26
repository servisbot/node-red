/**
 * Simple performance monitoring for Node-RED flows
 * Tracks memory usage and performance metrics to identify bottlenecks
 */

class SimpleFlowMonitor {
    constructor() {
        this.startTime = Date.now();
        this.operationCount = 0;
        this.cacheSize = 0;
        this.lastMemory = process.memoryUsage();
        this.baselineMemory = process.memoryUsage().heapUsed;
        
        // Track sequential operations for batching detection
        this.recentOperations = [];
        this.maxRecentOps = 50;
        
        // ANTI-SLOWDOWN: Track memory growth trends to detect gradual leaks
        this.memoryHistory = [];
        this.maxMemoryHistory = 20; // Keep last 20 samples for trend analysis
    }

    logOperation(operationType, details = {}) {
        this.operationCount++;
        const currentTime = Date.now();
        const currentMemory = process.memoryUsage();
        
        // ANTI-SLOWDOWN: Track memory trends for gradual leak detection
        this.memoryHistory.push({
            time: currentTime,
            heapUsed: currentMemory.heapUsed,
            heapTotal: currentMemory.heapTotal,
            operationType: operationType
        });
        
        // Keep only recent memory history
        if (this.memoryHistory.length > this.maxMemoryHistory) {
            this.memoryHistory.shift();
        }
        
        // Detect gradual memory growth trend
        if (this.memoryHistory.length >= 10 && this.operationCount % 25 === 0) {
            this.detectMemoryTrend();
        }
        
        // Track recent operations for pattern detection
        this.recentOperations.push({
            type: operationType,
            time: currentTime,
            details
        });
        
        // Keep only recent operations
        if (this.recentOperations.length > this.maxRecentOps) {
            this.recentOperations.shift();
        }
        
        this.lastMemory = currentMemory;
        
        // Alert on very long operations  
        if (details.flowId && operationType.endsWith('-complete')) {
            const operationTime = this.getOperationTime(operationType);
            if (operationTime > 10000) { // 10+ seconds
                console.warn(`[FlowMonitor] WARNING: Long operation ${operationType} took ${Math.round(operationTime/1000)}s`);
            }
        }
        
        // Detect sequential flow loading pattern
        this.detectBatchingOpportunity(operationType);
    }
    
    // Detect sequential flow loading pattern
    detectBatchingOpportunity(operationType) {
        if (!operationType.includes('setFlows-start')) return;
        
        // Count recent setFlows operations
        const recentSetFlows = this.recentOperations.filter(op => 
            op.type.includes('setFlows-start') && 
            (Date.now() - op.time) < 60000 // Within last 60 seconds
        );
        
        if (recentSetFlows.length > 5 && recentSetFlows.length % 10 === 0) {
            console.warn(`[FlowMonitor] BATCHING OPPORTUNITY: ${recentSetFlows.length} sequential flow operations detected. ` +
                        `Consider batching multiple flows into fewer operations for better performance.`);
        }
    }

    getOperationTime(_operationType) {
        // Simple heuristic: look at time since last matching start operation
        // This is approximate but good enough for monitoring
        return 0; // Simplified for now
    }

    trackCacheSize(registry) {
        if (registry && registry.getCacheStats) {
            const stats = registry.getCacheStats();
            if (stats.size !== this.cacheSize) {
                this.cacheSize = stats.size;
            }
        }
    }
    
    // ANTI-SLOWDOWN: Detect gradual memory growth trends
    detectMemoryTrend() {
        if (this.memoryHistory.length < 10) return;
        
        const recent = this.memoryHistory.slice(-10);
        const early = recent.slice(0, 5);
        const late = recent.slice(-5);
        
        const earlyAvg = early.reduce((sum, m) => sum + m.heapUsed, 0) / early.length;
        const lateAvg = late.reduce((sum, m) => sum + m.heapUsed, 0) / late.length;
        
        const growthMB = (lateAvg - earlyAvg) / (1024 * 1024);
        const growthPercent = (growthMB / (earlyAvg / (1024 * 1024))) * 100;
        
        // If memory has grown significantly (>20MB and >15%) in recent operations
        if (growthMB > 20 && growthPercent > 15) {
            console.warn(`[FlowMonitor] MEMORY TREND WARNING: Detected ${Math.round(growthMB)}MB growth (${Math.round(growthPercent)}%) over recent operations. Consider aggressive cache cleanup.`);
            
            // Return trending info for potential use by callers
            return {
                trending: 'up',
                growthMB: Math.round(growthMB),
                growthPercent: Math.round(growthPercent),
                currentHeapMB: Math.round(lateAvg / (1024 * 1024))
            };
        }
        
        return { trending: 'stable' };
    }

    getStats() {
        const currentMemory = process.memoryUsage();
        const memoryTrend = this.memoryHistory.length >= 10 ? this.detectMemoryTrend() : { trending: 'insufficient-data' };
        
        return {
            operationCount: this.operationCount,
            runtime: Date.now() - this.startTime,
            heapUsed: Math.round(currentMemory.heapUsed / 1024 / 1024),
            heapTotal: Math.round(currentMemory.heapTotal / 1024 / 1024),
            cacheSize: this.cacheSize,
            memoryTrend: memoryTrend,
            baselineHeapMB: Math.round(this.baselineMemory / 1024 / 1024),
            memoryGrowthFromBaseline: Math.round((currentMemory.heapUsed - this.baselineMemory) / 1024 / 1024)
        };
    }
}

module.exports = new SimpleFlowMonitor();