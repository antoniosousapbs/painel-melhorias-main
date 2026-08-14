import dotenv from 'dotenv';
import { resolve } from 'path';

// Load from project root
dotenv.config({ path: resolve(process.cwd(), '../../.env') });

console.log('CWD:', process.cwd());
console.log('SERVER:', process.env.DB_SERVER);
console.log('DB:', process.env.DB_DATABASE);
console.log('USER:', process.env.DB_USER);
console.log('PASS:', process.env.DB_PASSWORD);
console.log('PASS length:', process.env.DB_PASSWORD?.length);
