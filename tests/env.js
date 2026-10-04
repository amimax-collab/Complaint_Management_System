process.env.NODE_ENV = 'test';
process.env.DB_NAME = 'complaint_mgmt_test'; // never run tests against the seeded demonstration database
process.env.SESSION_SECRET = 'test-secret';
process.env.AUTO_CLOSE_DAYS = '7';
