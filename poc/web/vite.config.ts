/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 页面带 `style-src 'self'` 的 CSP：样式只能来自构建出的静态 CSS 文件，不能往页面里插 <style>。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    // 小文件也单独出文件，不内联成 data: 地址（前门只认 /assets/ 下真实存在的文件）。
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/test/**/*.test.tsx'],
    css: false,
    restoreMocks: true,
    // 等待元素的上限放到 3 秒（setup.ts），一项测试里有几次等待也不会撞上 vitest 默认的 5 秒
    testTimeout: 15000,
  },
});
