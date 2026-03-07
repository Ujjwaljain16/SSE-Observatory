import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
    title: "SSE Observatory",
    description: "Real-Time Observability for Server-Sent Event Streams",
    head: [
        ['link', { rel: 'icon', type: 'image/png', href: '/logo.png' }]
    ],
    themeConfig: {
        // https://vitepress.dev/reference/default-theme-config
        logo: '/logo.png',
        nav: [
            { text: 'Home', link: '/' },
            { text: 'Guide', link: '/guide/getting-started' },
            { text: 'Technical', link: '/technical/architecture' }
        ],

        sidebar: {
            '/guide/': [
                {
                    text: 'Introduction',
                    items: [
                        { text: 'Getting Started', link: '/guide/getting-started' }
                    ]
                },
                {
                    text: 'Features',
                    items: [
                        { text: 'Query DSL', link: '/guide/query-dsl' },
                        { text: 'Multi-Stream Correlation', link: '/guide/multi-stream' },
                        { text: 'JavaScript Interceptors', link: '/guide/interceptors' },
                        { text: 'Pattern Detection', link: '/guide/patterns' },
                        { text: 'Mock Server & Replay', link: '/guide/mock-server' }
                    ]
                }
            ],
            '/technical/': [
                {
                    text: 'Architecture',
                    items: [
                        { text: 'WebWorkers & Ring Buffers', link: '/technical/architecture' },
                        { text: 'Known Limitations', link: '/technical/limitations' }
                    ]
                }
            ]
        },

        socialLinks: [
            { icon: 'github', link: 'https://github.com/your-org/sse-observatory' }
        ],

        search: {
            provider: 'local'
        }
    }
})
