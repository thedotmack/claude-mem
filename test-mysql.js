const { MySQLDatabase, getMySQLConfig } = require('./dist/services/mysql/Database.js');

async function test() {
  console.log('=== 测试 MySQL 连接 ===');
  
  const config = getMySQLConfig();
  console.log('配置:', {
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database
  });
  
  const db = new MySQLDatabase(config);
  
  try {
    await db.initialize();
    console.log('✅ 数据库初始化成功');
    
    // 测试表是否存在
    const tables = await db.query('SHOW TABLES');
    console.log(`✅ 找到 ${tables.length} 张表`);
    
    if (tables.length > 0) {
      console.log('表列表:', tables.map(t => Object.values(t)[0]).join(', '));
    }
    
    await db.close();
    console.log('✅ 测试完成');
  } catch (err) {
    console.error('❌ 错误:', err.message);
    process.exit(1);
  }
}

test();
