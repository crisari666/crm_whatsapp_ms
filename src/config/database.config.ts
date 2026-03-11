import { registerAs } from '@nestjs/config';

export default registerAs('database', () => ({
  uri: `mongodb://${process.env.DATABASE_USER}:${process.env.DATABASE_PASS}@${process.env.DATABASE_HOST}:${process.env.DATABASE_PORT}/${process.env.DATABASE_NAME}`,
  host: process.env.DATABASE_HOST || 'not_defined',
  port: parseInt(process.env.DATABASE_PORT || 'not_defined', 10),
  database: process.env.DATABASE_NAME || 'not_defined',
  username: process.env.DATABASE_USER || 'not_defined',
  password: process.env.DATABASE_PASS || 'not_defined',
}));

