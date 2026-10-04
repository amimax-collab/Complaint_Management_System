-- Run once as a MySQL administrator. Creates databases and two accounts:
--   ccms_app   : least-privilege account used by the application
--   ccms_admin : privileged account used only for seeding and automated tests
CREATE DATABASE IF NOT EXISTS complaint_mgmt_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS complaint_mgmt_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'ccms_app'@'localhost' IDENTIFIED BY 'app_password_change_me';
CREATE USER IF NOT EXISTS 'ccms_admin'@'localhost' IDENTIFIED BY 'admin_password_change_me';
GRANT SELECT, INSERT, UPDATE, DELETE ON complaint_mgmt_db.* TO 'ccms_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON complaint_mgmt_test.* TO 'ccms_app'@'localhost';
GRANT ALL PRIVILEGES ON complaint_mgmt_db.* TO 'ccms_admin'@'localhost';
GRANT ALL PRIVILEGES ON complaint_mgmt_test.* TO 'ccms_admin'@'localhost';
FLUSH PRIVILEGES;
