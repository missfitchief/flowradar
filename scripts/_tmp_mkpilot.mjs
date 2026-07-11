import pg from 'pg';
const c = new pg.Client({ host:'127.0.0.1', port:5439, user:'flowradar', password:'flowradar', database:'postgres' });
await c.connect();
await c.query(`DROP DATABASE IF EXISTS flowradar_pilot`);
await c.query(`CREATE DATABASE flowradar_pilot TEMPLATE flowradar_backup_pre_snapbound`);
console.log('flowradar_pilot created from frozen backup');
await c.end();
