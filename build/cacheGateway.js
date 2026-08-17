#!/usr/bin/env node
import * as dotenv from 'dotenv';
import { createGatewayApp } from './gateway/app.js';
dotenv.config();
async function main() {
    const { app, config } = await createGatewayApp();
    const server = app.listen(config.port, config.host, () => {
        console.log(`Finance Cache Gateway listening on http://${config.host}:${config.port}`);
        console.log(`Configured model routes: ${config.models.map(route => route.id).join(', ') || 'none'}`);
        console.log(`State directory: ${config.dataDir}`);
    });
    const shutdown = (signal) => {
        console.log(`Received ${signal}; shutting down cache gateway`);
        server.close(error => {
            if (error) {
                console.error(error);
                process.exitCode = 1;
            }
        });
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
}
main().catch(error => {
    console.error('Cache gateway failed to start:', error);
    process.exit(1);
});
