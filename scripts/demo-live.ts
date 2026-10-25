// Cross-platform entry point for the live split-screen demo.
process.env.DEMO_LIVE = '1';
await import('../apps/demo/src/server');

export {};
