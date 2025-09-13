/**
 * 构建辅助脚本
 * 清理构建目录，执行构建并进行必要的后处理
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 确保build目录存在
const buildDir = path.join(__dirname, 'build');
if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true });
  console.log('✅ 创建build目录');
}

// 确保build/services目录存在
const servicesDir = path.join(buildDir, 'services');
if (!fs.existsSync(servicesDir)) {
  fs.mkdirSync(servicesDir, { recursive: true });
  console.log('✅ 创建build/services目录');
}

// 设置文件权限（跨平台兼容）
function setExecutablePermissions() {
  const files = ['build/index.js', 'build/httpServer.js'];
  
  files.forEach(file => {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
      try {
        // 在Unix-like系统（Mac/Linux）上设置可执行权限
        if (process.platform !== 'win32') {
          fs.chmodSync(filePath, '755');
          console.log(`✅ 设置 ${file} 可执行权限`);
        } else {
          console.log(`ℹ️  Windows系统跳过 ${file} 权限设置`);
        }
      } catch (error) {
        console.warn(`⚠️  设置 ${file} 权限失败:`, error.message);
      }
    }
  });
}

// 设置文件权限
setExecutablePermissions();
console.log('✅ 构建后处理完成');

// 显示Tushare统一配置提醒
console.log('\n🔔 提醒: Tushare API设置现在统一在 src/config.ts 文件中管理');
console.log('   如需修改API Token，请编辑该文件后重新运行本脚本\n');

// 完成
console.log('✨ 全部完成! 现在您可以运行服务器:');
console.log('   node build/index.js');
console.log('   或');
console.log('   npx supergateway --stdio "node build/index.js" --port 3100\n');