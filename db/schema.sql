-- complaint_mgmt_db schema (Third Normal Form), see Chapter Three, Table 3.6
CREATE TABLE users (
  user_id        INT AUTO_INCREMENT PRIMARY KEY,
  full_name      VARCHAR(100) NOT NULL,
  email          VARCHAR(120) NOT NULL,
  phone          VARCHAR(20),
  password_hash  VARCHAR(255) NOT NULL,
  role           ENUM('customer','officer','supervisor','admin') NOT NULL DEFAULT 'customer',
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at  TIMESTAMP NULL,
  CONSTRAINT uq_users_email UNIQUE (email),
  INDEX idx_users_role_active (role, is_active)
) ENGINE=InnoDB;

CREATE TABLE categories (
  category_id      INT AUTO_INCREMENT PRIMARY KEY,
  category_name    VARCHAR(80) NOT NULL UNIQUE,
  description      VARCHAR(255),
  default_priority ENUM('Low','Medium','High') NOT NULL DEFAULT 'Medium',
  resolution_hours INT NOT NULL,
  CONSTRAINT chk_resolution_hours CHECK (resolution_hours > 0)
) ENGINE=InnoDB;

CREATE TABLE complaints (
  complaint_id        INT AUTO_INCREMENT PRIMARY KEY,
  reference_no        VARCHAR(20) NOT NULL,
  customer_id         INT NOT NULL,
  category_id         INT NOT NULL,
  assigned_officer_id INT NULL,
  subject             VARCHAR(150) NOT NULL,
  description         TEXT NOT NULL,
  priority            ENUM('Low','Medium','High') NOT NULL DEFAULT 'Medium',
  status              ENUM('Submitted','Assigned','In Progress','Resolved','Closed') NOT NULL DEFAULT 'Submitted',
  is_escalated        TINYINT(1) NOT NULL DEFAULT 0,
  submitted_at        DATETIME NOT NULL,
  due_at              DATETIME NOT NULL,
  escalated_at        DATETIME NULL,
  resolved_at         DATETIME NULL,
  closed_at           DATETIME NULL,
  CONSTRAINT uq_complaints_reference UNIQUE (reference_no),
  CONSTRAINT fk_complaints_customer FOREIGN KEY (customer_id) REFERENCES users(user_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_complaints_category FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_complaints_officer  FOREIGN KEY (assigned_officer_id) REFERENCES users(user_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  INDEX idx_complaints_customer (customer_id, submitted_at),
  INDEX idx_complaints_officer (assigned_officer_id, status),
  INDEX idx_complaints_due (status, is_escalated, due_at),
  INDEX idx_complaints_category (category_id, submitted_at),
  INDEX idx_complaints_queue (due_at, complaint_id)
) ENGINE=InnoDB;

CREATE TABLE complaint_updates (
  update_id           INT AUTO_INCREMENT PRIMARY KEY,
  complaint_id        INT NOT NULL,
  author_id           INT NULL,
  update_type         ENUM('Note','Customer Message','Officer Message','Status Change','Assignment','Escalation','Resolution') NOT NULL,
  message             TEXT NOT NULL,
  visible_to_customer TINYINT(1) NOT NULL DEFAULT 0,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_updates_complaint FOREIGN KEY (complaint_id) REFERENCES complaints(complaint_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_updates_author FOREIGN KEY (author_id) REFERENCES users(user_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  INDEX idx_updates_complaint (complaint_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE feedback (
  feedback_id  INT AUTO_INCREMENT PRIMARY KEY,
  complaint_id INT NOT NULL,
  rating       TINYINT NOT NULL,
  comment      VARCHAR(500),
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_feedback_complaint UNIQUE (complaint_id),
  CONSTRAINT chk_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT fk_feedback_complaint FOREIGN KEY (complaint_id) REFERENCES complaints(complaint_id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE notifications (
  notification_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NOT NULL,
  complaint_id    INT NOT NULL,
  subject         VARCHAR(150) NOT NULL,
  message         TEXT NOT NULL,
  delivery_status ENUM('Pending','Sent','Failed') NOT NULL DEFAULT 'Pending',
  sent_at         TIMESTAMP NULL,
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_notif_complaint FOREIGN KEY (complaint_id) REFERENCES complaints(complaint_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  INDEX idx_notifications_user (user_id, sent_at)
) ENGINE=InnoDB;

CREATE TABLE audit_log (
  audit_id    BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NULL,
  action      VARCHAR(50) NOT NULL,
  entity_type VARCHAR(30),
  entity_id   INT,
  details     JSON,
  ip_address  VARCHAR(45),
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  INDEX idx_audit_entity (entity_type, entity_id),
  INDEX idx_audit_created (created_at)
) ENGINE=InnoDB;
