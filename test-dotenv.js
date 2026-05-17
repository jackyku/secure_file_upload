require('dotenv').config();
console.log('DATABASE_URL:', process.env.DATABASE_URL);
console.log('DATABASE_URL exists?', !!process.env.DATABASE_URL);
