import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
    title: "SSE Observatory",
    description: "Real-Time Observability for Server-Sent Event Streams",
    base: '/docs/',
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
                        { text: 'Mock Server & Replay', link: '/guide/mock-server' },
                        { text: 'Stream Doctor (in the app)', link: '/guide/stream-doctor' },
                        { text: 'Command Line (sse-doctor)', link: '/guide/cli' },
                        { text: 'Scenarios & CI', link: '/guide/cli-ci' }
                    ]
                }
            ],
            '/technical/': [
                {
                    text: 'Architecture',
                    items: [
                        { text: 'WebWorkers & Ring Buffers', link: '/technical/architecture' },
                        { text: 'Proxy Diagnostics', link: '/technical/proxy-diagnostics' },
                        { text: 'Diagnostics', link: '/technical/diagnostics' },
                        { text: 'Capture Format', link: '/technical/capture-format' },
                        { text: 'Known Limitations', link: '/technical/limitations' }
                    ]
                }
            ]
        },

        socialLinks: [
            { icon: 'github', link: 'https://github.com/Ujjwaljain16/SSE-Observatory' }
        ],

        search: {
            provider: 'local'
        }
    }
})
