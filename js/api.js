class APIService {
    constructor() {
        this.maxRetries = 3;
        this.baseDelay = 1000;
    }

    // ===== Gemini compatibility helpers =====
    isGeminiHost(u) {
        try { const h = new URL(u).host; return /generativelanguage\.googleapis\.com$/i.test(h); } catch { return false; }
    }
    geminiBase(u) {
        try {
            const url = new URL(u);
            const parts = url.pathname.split('/').filter(Boolean);
            const i = parts.findIndex(p => /^v\d/.test(p));
            const version = i >= 0 ? parts[i] : 'v1beta';
            return `${url.origin}/${version}`;
        } catch { return u; }
    }
    normalizeEndpoint(apiUrl) {
        const trimmed = apiUrl.replace(/\/$/, '');
        if (this.isGeminiHost(apiUrl)) return apiUrl;
        if (/\/v1$/i.test(trimmed)) return trimmed + '/chat/completions';
        return apiUrl;
    }


    /**
     * 通用的OpenAI兼容API调用函数
     * @param {string} apiUrl - API地址
     * @param {string} apiKey - API密钥
     * @param {string} model - 模型名称
     * @param {Array} messages - 消息数组
     * @param {Object} options - 额外选项
     * @param {number} timeout - 超时时间(毫秒)，默认60秒
     * @returns {Promise} API响应
     */
    async callOpenAIAPI(apiUrl, apiKey, model, messages, options = {}, timeout = 60000) {
        const payload = {
            model: model,
            messages: messages,
            ...options
        };

        for (let i = 0; i < this.maxRetries; i++) {
            try {
                const requestBody = {
                    apiUrl: apiUrl,
                    apiKey: apiKey,
                    model: model,
                    messages: messages,
                    ...options
                };
                
                // 创建AbortController用于超时控制
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeout);
                
                // 将请求路径修改为 /api/proxy/ 以匹配 netlify.toml 中的规则
                const response = await fetch('/api/proxy/', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    // 特殊处理504错误（Gateway Timeout）
                    if (response.status === 504) {
                        throw new Error(`请求超时(504): 模型响应时间过长，请稍后重试`);
                    }
                    
                    try {
                        const errorBody = await response.json();
                        throw new Error(`代理请求失败: ${response.status} - ${errorBody.error}`);
                    } catch (parseError) {
                        // 如果错误响应也无法解析JSON，返回状态码
                        throw new Error(`代理请求失败: ${response.status} - ${response.statusText}`);
                    }
                }
                
                // 尝试解析JSON响应
                try {
                    const data = await response.json();
                    console.log('API完整返回:', JSON.stringify(data, null, 2));
                    return data;
                } catch (parseError) {
                    throw new Error(`响应格式错误: 无法解析API返回的JSON数据`);
                }

            } catch (error) {
                // AbortError (超时) 不重试
                if (error.name === 'AbortError') {
                    throw new Error('请求超时: 模型响应时间过长，请稍后重试');
                }
                
                if (i < this.maxRetries - 1) {
                    const delay = this.baseDelay * Math.pow(2, i);
                    await new Promise(res => setTimeout(res, delay));
                } else {
                    throw error;
                }
            }
        }
    }

    /**
     * 测试API连接
     * @param {string} apiUrl - API地址
     * @param {string} apiKey - API密钥
     * @returns {Promise} 连接测试结果
     */
    async testConnection(apiUrl, apiKey) {
        if (this.isGeminiHost(apiUrl)) {
            const base = this.geminiBase(apiUrl);
            let url = `${base}/models?key=${encodeURIComponent(apiKey)}`;
            const response = await fetch(url, { method: 'GET', headers: { 'x-goog-api-key': apiKey }});
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`连接失败: ${response.status} - ${text}`);
            }
            const data = await response.json();
            if (Array.isArray(data.models)) {
                return data.models.map(m => ({ id: (m.name || '').replace(/^models\//,'') }));
            }
            return data;
        }
        const response = await fetch(`${apiUrl.replace(/\/$/, '')}/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`连接失败: ${response.status} - ${text}`);
        }
        return await response.json();
    }
}

// 导出类供使用
if (typeof module !== 'undefined' && module.exports) {
    module.exports = APIService;
} else if (typeof window !== 'undefined') {
    window.apiService = new APIService();
}