const mysql = require('mysql2/promise');
const { logger } = require('./winston');
const secret = require('./secret');


const pool = mysql.createPool({
  host: secret.host,
  user: secret.user,
  port: secret.port,
  password: secret.password,
  database: secret.database,

  // DATE 컬럼을 JS Date 객체로 바꾸지 않고 문자열 그대로 받기
  // 예: 2026-06-17 그대로 유지
  dateStrings: true,

  // 서버/DB 시간대 차이 보정
  timezone: '+09:00',
});

async function checkDatabase() {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT DATABASE() AS db');
    logger.info(`현재 연결된 데이터베이스: ${rows[0].db}`);
    logger.info(`DB_HOST: ${secret.host}`);
    logger.info(`DB_USER: ${secret.user}`);
    logger.info(`DB_NAME: ${secret.database}`);
    connection.release();
  } catch (err) {
    logger.error('데이터베이스 연결 확인 중 오류 발생:', err);
  }
}

checkDatabase();

module.exports = {
  pool: pool,
};
