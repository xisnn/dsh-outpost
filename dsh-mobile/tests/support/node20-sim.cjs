/**
 * 模拟 Node 20 环境。
 *
 * 用法：
 *   node --require ./tests/support/node20-sim.cjs tests/integration-transport.mjs
 *
 * ## 为什么需要
 *
 * CI 用 Node 20，本地开发常用 Node 24。最大差异之一是
 * **全局 WebSocket 21+ 才有**。删掉它就能复现 CI 的环境，
 * 在本地提前发现问题，不用等推上去才失败。
 *
 * 这个文件被 
pm run test:node20 用来跑全部集成测试。
 */

// Node 21+ 才有；删掉模拟 20
delete globalThis.WebSocket;
