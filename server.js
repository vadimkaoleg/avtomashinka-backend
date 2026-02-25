import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import initSqlJs from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'basic-ftp';
const { Client: FTPClient } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// 🔐 FIXED: Константный JWT_SECRET для всех запросов
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-for-autoschool-mashinka-12345';

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:3001', 'https://avmashinka.ru', 'https://www.avmashinka.ru'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Логирование всех запросов
app.use((req, res, next) => {
  console.log(`📥 ${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Папки для файлов
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// 📤 Конфигурация FTP для бэкапа файлов
const FTP_CONFIG = {
  host: process.env.FTP_HOST || '88.212.206.32',
  port: parseInt(process.env.FTP_PORT) || 21,
  user: process.env.FTP_USER || 'cl433989_render',
  password: process.env.FTP_PASS || 'jA1yU5cC9w',
  remotePath: process.env.FTP_PATH || 'uploads'
};

// Флаг для отключения FTP если недоступен
let ftpEnabled = true;

// Функция загрузки файла на FTP
async function uploadToFTP(localFilePath, fileName) {
  if (!ftpEnabled) {
    console.log(`⏭️ FTP отключен, пропускаем загрузку: ${fileName}`);
    return false;
  }
  
  const client = new FTPClient();
  
  try {
    console.log(`🔌 Подключение к FTP ${FTP_CONFIG.host}:${FTP_CONFIG.port}...`);
    
    await client.connect(FTP_CONFIG.host, FTP_CONFIG.port);
    await client.login(FTP_CONFIG.user, FTP_CONFIG.password);
    console.log(`✅ FTP подключение установлено`);
    
    // Проверяем/создаем папку на FTP
    try {
      await client.cd(FTP_CONFIG.remotePath);
    } catch {
      try {
        await client.mkdir(FTP_CONFIG.remotePath);
        await client.cd(FTP_CONFIG.remotePath);
      } catch (mkdirErr) {
        console.warn('⚠️ Не удалось создать папку на FTP:', mkdirErr.message);
      }
    }
    
    // Загружаем файл
    await client.uploadFrom(localFilePath, fileName);
    
    console.log(`✅ Файл загружен на FTP: ${fileName}`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка FTP загрузки:', error.message);
    
    // Если недоступен - отключаем FTP
    if (error.message.includes('Timed out') || error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND')) {
      console.warn('⚠️ FTP недоступен, отключаем для оптимизации');
      ftpEnabled = false;
    }
    
    return false;
  } finally {
    try {
      await client.close();
    } catch {}
  }
}

// Функция скачивания файла с FTP (если нет локально)
// Всегда пытается подключиться, не зависит от ftpEnabled
async function downloadFromFTP(fileName, localPath) {
  const client = new FTPClient();
  
  try {
    console.log(`📥 Скачивание с FTP: ${fileName}...`);
    console.log(`   FTP хост: ${FTP_CONFIG.host}:${FTP_CONFIG.port}, путь: ${FTP_CONFIG.remotePath}`);
    
    await client.connect(FTP_CONFIG.host, FTP_CONFIG.port);
    await client.login(FTP_CONFIG.user, FTP_CONFIG.password);
    console.log(`   ✅ FTP подключен`);
    
    // Проверяем список файлов на FTP для отладки
    try {
      await client.cd(FTP_CONFIG.remotePath);
      const fileList = await client.list();
      console.log(`   📂 Файлов на FTP: ${fileList.length}`);
      const found = fileList.find(f => f.name === fileName);
      if (found) {
        console.log(`   ✅ Найден файл на FTP: ${fileName} (${found.size} bytes)`);
      } else {
        console.log(`   ⚠️ Файл НЕ найден на FTP! Список файлов:`, fileList.map(f => f.name).slice(0, 10));
      }
    } catch (cdErr) {
      console.log(`   ⚠️ Не удалось войти в папку ${FTP_CONFIG.remotePath}:`, cdErr.message);
    }
    
    try {
      await client.downloadTo(localPath, fileName);
      console.log(`✅ Файл скачан с FTP: ${fileName}`);
      
      // Проверяем что скачалось
      if (fs.existsSync(localPath)) {
        const stat = fs.statSync(localPath);
        console.log(`   📄 Локальный файл: ${stat.size} bytes`);
      }
      
      return true;
    } catch (downloadErr) {
      console.log(`   ❌ Ошибка скачивания:`, downloadErr.message);
      return false;
    }
  } catch (error) {
    console.error('❌ Ошибка подключения к FTP:', error.message);
    return false;
  } finally {
    try {
      await client.close();
    } catch {}
  }
}

// Функция удаления файла с FTP
async function deleteFromFTP(fileName) {
  if (!ftpEnabled) {
    console.log(`⏭️ FTP отключен, пропускаем удаление: ${fileName}`);
    return false;
  }
  
  const client = new FTPClient();
  
  try {
    await client.connect(FTP_CONFIG.host, FTP_CONFIG.port);
    await client.login(FTP_CONFIG.user, FTP_CONFIG.password);
    
    try {
      await client.cd(FTP_CONFIG.remotePath);
      await client.remove(fileName);
      console.log(`✅ Файл удален с FTP: ${fileName}`);
    } catch {
      console.log(`⚠️ Файл не найден на FTP: ${fileName}`);
    }
    
    return true;
  } catch (error) {
    console.error('❌ Ошибка удаления с FTP:', error.message);
    
    if (error.message.includes('Timed out') || error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND')) {
      console.warn('⚠️ FTP недоступен, отключаем для оптимизации');
      ftpEnabled = false;
    }
    
    return false;
  } finally {
    try {
      await client.close();
    } catch {}
  }
}

// MIME types
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.zip': 'application/zip',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain'
  };
  return types[ext] || 'application/octet-stream';
}

// Настройка Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /pdf|jpeg|jpg|png|gif|doc|docx|xls|xlsx|txt|zip/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      cb(null, true);
    } else {
      cb(new Error('Неподдерживаемый тип файла'));
    }
  }
});

// База данных
let db;

async function initDatabase() {
  const SQL = await initSqlJs();
  
  const dbPath = path.join(__dirname, 'database.sqlite');
  
  // Загружаем существующую БД или создаём новую
  let fileBuffer = null;
  if (fs.existsSync(dbPath)) {
    fileBuffer = fs.readFileSync(dbPath);
  }
  
  db = new SQL.Database(fileBuffer);

  db.run(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_size INTEGER,
      file_type TEXT,
      is_visible INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Добавляем колонку sort_order если её нет (миграция)
  try {
    db.run("ALTER TABLE documents ADD COLUMN sort_order INTEGER DEFAULT 0");
  } catch (e) {
    // Колонка уже существует
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      title TEXT,
      subtitle TEXT,
      content TEXT,
      button_text TEXT,
      button_link TEXT,
      image TEXT,
      items TEXT,
      is_visible INTEGER DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Заполняем таблицу блоков начальными данными
  const defaultBlocks = [
    { name: 'hero', title: 'Мы не просто автошкола.', subtitle: 'Мы — Академия будущих водителей!', content: 'Автошкола "Машинка" предлагает качественное обучение вождению с опытными инструкторами. Получите права быстро и надежно!', button_text: 'Записаться сейчас', button_link: 'contact', is_visible: 1 },
    { name: 'about', title: 'О нас', subtitle: '', content: 'Мы работаем уже более 10 лет и помогли тысячам учеников получить водительские права. Наши инструкторы — профессионалы с многолетним стажем.', button_text: '', button_link: '', is_visible: 1 },
    { name: 'advantages', title: 'Почему выбирают нас', subtitle: '', content: '', button_text: '', button_link: '', items: JSON.stringify([{ title: 'Опытные инструкторы', description: 'Стаж работы от 5 лет' },{ title: 'Современные авто', description: 'Новые и безопасные автомобили' },{ title: 'Гибкий график', description: 'Обучение в удобное время' }]), is_visible: 1 },
    { name: 'courses', title: 'Наши курсы', subtitle: '', content: '', button_text: '', button_link: '', items: JSON.stringify([{ title: 'Категория B', price: 'от 25 000 ₽', description: 'Обучение на легковой автомобиль' },{ title: 'Категория A', price: 'от 15 000 ₽', description: 'Обучение на мотоцикл' },{ title: 'Категория C', price: 'от 35 000 ₽', description: 'Обучение на грузовой автомобиль' }]), is_visible: 1 },
    { name: 'contact', title: 'Связаться с нами', subtitle: 'Оставьте заявку', content: 'Заполните форму и мы свяжемся с вами в ближайшее время', button_text: 'Отправить заявку', button_link: '', is_visible: 1 },
    { name: 'footer', title: '', subtitle: '', content: '© 2024 Автошкола "Машинка". Все права защищены.', button_text: '', button_link: '', items: JSON.stringify([{ title: 'Телефон', value: '+7 (999) 123-45-67' },{ title: 'Email', value: 'info@mashinka.ru' },{ title: 'Адрес', value: 'г. Москва, ул. Примерная, д. 1' }]), is_visible: 1 }
  ];

  for (const block of defaultBlocks) {
    const result = db.exec("SELECT id FROM blocks WHERE name = ?", [block.name]);
    if (result.length === 0 || result[0].values.length === 0) {
      db.run(
        "INSERT INTO blocks (name, title, subtitle, content, button_text, button_link, items, is_visible) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [block.name, block.title, block.subtitle || '', block.content || '', block.button_text || '', block.button_link || '', block.items || null, block.is_visible || 1]
      );
      console.log(`✅ Создан блок: ${block.name}`);
    }
  }

  // Проверим все блоки
  const allBlocks = db.exec("SELECT id, name, is_visible FROM blocks");
  console.log('📦 Блоки в БД:', allBlocks);

  // Создаем начального администратора (или обновляем пароль)
  const adminResult = db.exec("SELECT * FROM admin_users WHERE username = 'admin'");
  const hash = bcrypt.hashSync('admin123', 10);
  
  if (adminResult.length === 0 || adminResult[0].values.length === 0) {
    db.run(
      "INSERT INTO admin_users (username, password_hash) VALUES (?, ?)",
      ['admin', hash]
    );
    console.log('✅ Создан администратор: admin / admin123');
  } else {
    db.run(
      "UPDATE admin_users SET password_hash = ? WHERE username = 'admin'",
      [hash]
    );
    console.log('🔄 Обновлен пароль администратора: admin / admin123');
  }

  // Сохраняем БД
  saveDatabase();
    
  console.log('✅ База данных инициализирована');
  console.log(`🔐 JWT Secret: ${JWT_SECRET ? 'Установлен' : 'Используется дефолтный'}`);
}

// Функция сохранения БД в файл
function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(path.join(__dirname, 'database.sqlite'), buffer);
}

// Вспомогательные функции для работы с БД
function dbGet(sql, params = []) {
  const result = db.exec(sql, params);
  if (result.length === 0 || result[0].values.length === 0) return null;
  const columns = result[0].columns;
  const values = result[0].values[0];
  const row = {};
  columns.forEach((col, i) => row[col] = values[i]);
  return row;
}

function dbAll(sql, params = []) {
  const result = db.exec(sql, params);
  if (result.length === 0) return [];
  const columns = result[0].columns;
  return result[0].values.map(values => {
    const row = {};
    columns.forEach((col, i) => row[col] = values[i]);
    return row;
  });
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDatabase();
  return { lastID: db.exec("SELECT last_insert_rowid()")[0].values[0][0] };
}

initDatabase().catch(console.error);

// 🔐 FIXED: Middleware аутентификации с исправленной проверкой
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  console.log('🔐 Проверка токена:', {
    hasAuthHeader: !!authHeader,
    tokenLength: token ? token.length : 0,
    endpoint: req.path
  });
  
  if (!token) {
    console.log('❌ Токен отсутствует');
    return res.status(401).json({ error: 'Токен отсутствует' });
  }
  
  try {
    // 🔐 FIXED: Синхронная проверка с правильным секретом
    const user = jwt.verify(token, JWT_SECRET);
    req.user = user;
    console.log('✅ Токен верифицирован для пользователя:', user.username);
    next();
  } catch (err) {
    console.error('❌ Ошибка верификации токена:', {
      error: err.message,
      token: token.substring(0, 20) + '...'
    });
    
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Токен истек' });
    }
    
    return res.status(403).json({ 
      error: 'Недействительный токен',
      details: err.message 
    });
  }
};

// 📊 КОРНЕВОЙ МАРШРУТ - ВАЖНО ДОБАВИТЬ
app.get('/', (req, res) => {
  res.json({
    message: '🚀 AutoSchool API Server',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      api: {
        documents: 'GET /api/documents',
        download: 'GET /api/download/:filename',
        health: 'GET /api/health',
        login: 'POST /api/login',
        verifyToken: 'GET /api/verify-token'
      },
      admin: {
        documents: 'GET /api/admin/documents (требуется токен)',
        upload: 'POST /api/admin/documents (требуется токен)',
        update: 'PUT /api/admin/documents/:id (требуется токен)',
        delete: 'DELETE /api/admin/documents/:id (требуется токен)',
        serverInfo: 'GET /api/server-info (требуется токен)'
      }
    },
    adminCredentials: {
      username: 'admin',
      password: 'admin123'
    },
    timestamp: new Date().toISOString()
  });
});

// 📊 АУТЕНТИФИКАЦИЯ

// Вход в систему
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    console.log('🔑 Попытка входа:', username);
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Заполните все поля' });
    }
    
    if (!db) {
      console.error('❌ База данных не инициализирована');
      return res.status(500).json({ error: 'База данных не готова' });
    }
    
    const user = dbGet(
      "SELECT * FROM admin_users WHERE username = ?",
      [username]
    );
    
    console.log('👤 Найден пользователь:', user ? user.username : 'НЕТ');
    
    if (!user) {
      return res.status(401).json({ error: 'Пользователь не найден' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password_hash);
    console.log('🔐 Пароль верный:', validPassword);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }
    
    // 🔐 FIXED: Используем константный JWT_SECRET
    const token = jwt.sign(
      { 
        id: user.id, 
        username: user.username
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    console.log('✅ Успешный вход для пользователя:', username);
    
    res.json({
      success: true,
      token,
      username: user.username,
      expiresIn: '24h'
    });
    
  } catch (error) {
    console.error('❌ Ошибка при входе:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 🔐 FIXED: Проверка токена
app.get('/api/verify-token', authenticateToken, (req, res) => {
  res.json({
    success: true,
    user: req.user,
    valid: true
  });
});

// 📁 УПРАВЛЕНИЕ ДОКУМЕНТАМИ

// Получить все документы (публичный доступ) - БЕЗ аутентификации
app.get('/api/documents', async (req, res) => {
  try {
    const documents = dbAll(
      "SELECT * FROM documents WHERE is_visible = 1 ORDER BY sort_order ASC, created_at DESC"
    );
    
    // 🔐 FIXED: Используем относительные URL для фронтенда
    const docsWithUrls = documents.map(doc => ({
      ...doc,
      downloadUrl: `/api/download/${doc.filename}`,
      is_visible: Boolean(doc.is_visible)
    }));
    
    res.json(docsWithUrls);
  } catch (error) {
    console.error('❌ Ошибка получения документов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 🔐 FIXED: Получить документы для админки (требуется токен)
app.get('/api/admin/documents', authenticateToken, async (req, res) => {
  try {
    const documents = dbAll(
      "SELECT * FROM documents ORDER BY sort_order ASC, created_at DESC"
    );
    
    const docsWithUrls = documents.map(doc => ({
      ...doc,
      downloadUrl: `/api/download/${doc.filename}`,
      is_visible: Boolean(doc.is_visible)
    }));
    
    console.log(`✅ Отправлено ${documents.length} документов для админа`);
    res.json(docsWithUrls);
  } catch (error) {
    console.error('❌ Ошибка получения документов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить порядок документов
app.put('/api/admin/documents/reorder', authenticateToken, async (req, res) => {
  try {
    const { order } = req.body; // Массив id в нужном порядке: [3, 1, 2]
    
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: 'Неверный формат данных' });
    }
    
    // Обновляем sort_order для каждого документа
    order.forEach((id, index) => {
      dbRun("UPDATE documents SET sort_order = ? WHERE id = ?", [index, id]);
    });
    
    console.log(`✅ Обновлен порядок документов: ${order.join(', ')}`);
    
    res.json({ 
      success: true, 
      message: 'Порядок документов обновлен' 
    });
  } catch (error) {
    console.error('❌ Ошибка обновления порядка:', error);
    res.status(500).json({ error: 'Ошибка при обновлении порядка' });
  }
});

// Загрузить документы (один или несколько)
app.post('/api/admin/documents', authenticateToken, upload.any(), async (req, res) => {
  try {
    const { title, description, is_visible = 'true' } = req.body;
    const files = req.files;
    
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    // Фильтруем только файлы (не другие поля)
    const fileList = files.filter(f => f.fieldName === 'file' || !f.fieldName);
    
    if (fileList.length === 0) {
      return res.status(400).json({ error: 'Файл не найден в запросе' });
    }
    
    const uploadedIds = [];
    
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const fileTitle = fileList.length === 1 
        ? (title || file.originalname.replace(/\.[^/.]+$/, ''))
        : `${title || file.originalname.replace(/\.[^/.]+$/, '')} ${i + 1}`;
      
      const fileType = path.extname(file.originalname).toLowerCase() === '.pdf' ? 'pdf' : 'image';
      
      const result = dbRun(
        `INSERT INTO documents 
         (title, description, filename, original_name, file_size, file_type, is_visible) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          fileTitle,
          description ? description.trim() : null,
          file.filename,
          file.originalname,
          file.size,
          fileType,
          is_visible === 'true' ? 1 : 0
        ]
      );
      
      uploadedIds.push(result.lastID);
      
      // 📤 Загружаем файл на FTP бэкап (не блокирует ответ)
      const ftpResult = await uploadToFTP(file.path, file.filename);
      if (ftpResult) {
        console.log(`💾 FTP бэкап создан для: ${file.filename}`);
      } else {
        console.warn(`⚠️ FTP бэкап НЕ создан для: ${file.filename} (файл сохранён локально)`);
      }
      
      console.log(`✅ Загружен документ: ${fileTitle} (${file.originalname})`);
    }
    
    res.status(201).json({
      success: true,
      ids: uploadedIds,
      count: uploadedIds.length,
      message: `Загружено ${uploadedIds.length} документ(ов)`
    });
    
  } catch (error) {
    console.error('❌ Ошибка загрузки документа:', error);
    
    // Удаляем загруженные файлы при ошибке
    if (req.files) {
      for (const file of req.files) {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
    }
    
    res.status(500).json({ 
      error: 'Ошибка при загрузке файла',
      details: error.message 
    });
  }
});

// Обновить документ
app.put('/api/admin/documents/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, is_visible } = req.body;
    
    const existingDoc = dbGet("SELECT * FROM documents WHERE id = ?", [id]);
    if (!existingDoc) {
      return res.status(404).json({ error: 'Документ не найден' });
    }
    
    dbRun(
      `UPDATE documents 
       SET title = ?, description = ?, is_visible = ? 
       WHERE id = ?`,
      [
        title ? title.trim() : existingDoc.title,
        description !== undefined ? description.trim() : existingDoc.description,
        is_visible !== undefined ? (is_visible === 'true' ? 1 : 0) : existingDoc.is_visible,
        id
      ]
    );

    console.log(`✅ Обновлен документ ID: ${id}`);
    
    res.json({
      success: true, 
      message: 'Документ обновлен' 
    });
    
  } catch (error) {
    console.error('❌ Ошибка обновления документа:', error);
    res.status(500).json({ error: 'Ошибка при обновлении' });
  }
});

// Удалить документ
app.delete('/api/admin/documents/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const doc = dbGet("SELECT * FROM documents WHERE id = ?", [id]);
    if (!doc) {
      return res.status(404).json({ error: 'Документ не найден' });
    }
    
    // Удаляем локальный файл
    const filePath = path.join(uploadsDir, doc.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    // 📤 Удаляем файл с FTP
    const ftpResult = await deleteFromFTP(doc.filename);
    if (!ftpResult) {
      console.warn(`⚠️ FTP бэкап НЕ удалён для: ${doc.filename}`);
    }
    
    dbRun("DELETE FROM documents WHERE id = ?", [id]);
    
    console.log(`🗑️ Удален документ ID: ${id} (${doc.title})`);
    
    res.json({ 
      success: true, 
      message: 'Документ удален' 
    });
    
  } catch (error) {
    console.error('❌ Ошибка удаления документа:', error);
    res.status(500).json({ error: 'Ошибка при удалении' });
  }
});

// 📷 ЗАГРУЗКА ИЗОБРАЖЕНИЙ ДЛЯ БЛОКОВ
app.post('/api/admin/blocks/upload-image', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    // 📤 Загружаем изображение на FTP бэкап (не блокирует ответ)
    const ftpResult = await uploadToFTP(file.path, file.filename);
    if (ftpResult) {
      console.log(`💾 FTP бэкап изображения создан: ${file.filename}`);
    } else {
      console.warn(`⚠️ FTP бэкап изображения НЕ создан: ${file.filename}`);
    }

    res.json({
      success: true,
      filename: file.filename,
      url: `/uploads/${file.filename}`
    });
  } catch (error) {
    console.error('❌ Ошибка загрузки изображения:', error);
    res.status(500).json({ error: 'Ошибка при загрузке' });
  }
});

// 📦 УПРАВЛЕНИЕ БЛОКАМИ

// Получить все блоки (публичный доступ)
app.get('/api/blocks', async (req, res) => {
  try {
    const blocks = dbAll("SELECT * FROM blocks WHERE is_visible = 1");
    const blocksData = blocks.map(block => ({
      ...block,
      items: block.items ? JSON.parse(block.items) : null,
      is_visible: Boolean(block.is_visible)
    }));
    res.json(blocksData);
  } catch (error) {
    console.error('❌ Ошибка получения блоков:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить блок по имени (публичный доступ)
app.get('/api/blocks/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const block = dbGet("SELECT * FROM blocks WHERE name = ? AND is_visible = 1", [name]);
    if (!block) {
      return res.status(404).json({ error: 'Блок не найден' });
    }
    res.json({
      ...block,
      items: block.items ? JSON.parse(block.items) : null,
      is_visible: Boolean(block.is_visible)
    });
  } catch (error) {
    console.error('❌ Ошибка получения блока:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить все блоки для админки
app.get('/api/admin/blocks', authenticateToken, async (req, res) => {
  try {
    const blocks = await dbAll("SELECT * FROM blocks ORDER BY id");
    const blocksData = blocks.map(block => ({
      ...block,
      items: block.items ? JSON.parse(block.items) : null,
      is_visible: Boolean(block.is_visible)
    }));
    res.json(blocksData);
  } catch (error) {
    console.error('❌ Ошибка получения блоков:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить блок
app.put('/api/admin/blocks/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, subtitle, content, button_text, button_link, image, items, is_visible } = req.body;

    const existingBlock = dbGet("SELECT * FROM blocks WHERE id = ?", [id]);
    if (!existingBlock) {
      return res.status(404).json({ error: 'Блок не найден' });
    }

    const itemsJson = items ? JSON.stringify(items) : existingBlock.items;

    dbRun(
      `UPDATE blocks 
       SET title = ?, subtitle = ?, content = ?, button_text = ?, button_link = ?, image = ?, items = ?, is_visible = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        title !== undefined ? title : existingBlock.title,
        subtitle !== undefined ? subtitle : existingBlock.subtitle,
        content !== undefined ? content : existingBlock.content,
        button_text !== undefined ? button_text : existingBlock.button_text,
        button_link !== undefined ? button_link : existingBlock.button_link,
        image !== undefined ? image : existingBlock.image,
        itemsJson,
        is_visible !== undefined ? (is_visible ? 1 : 0) : existingBlock.is_visible,
        id
      ]
    );

    console.log(`✅ Обновлен блок ID: ${id} (${existingBlock.name})`);

    res.json({ success: true, message: 'Блок обновлен' });
  } catch (error) {
    console.error('❌ Ошибка обновления блока:', error);
    res.status(500).json({ error: 'Ошибка при обновлении' });
  }
});

// 📥 РАБОТА С ФАЙЛАМИ (до middleware /api/*)

// 🔐 FIXED: Скачивание/предпросмотр файла (публичный доступ)
// ?mode=preview - для предпросмотра в браузере (inline)
// ?mode=download или без параметра - для скачивания (attachment)
app.get('/api/download/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(uploadsDir, filename);
    const mode = req.query.mode || 'download';
    
    // 📥 Если файла нет локально - пробуем скачать с FTP (без проверки ftpEnabled)
    if (!fs.existsSync(filePath)) {
      console.log(`📥 Файл не найден локально: ${filename}, пробуем с FTP...`);
      const downloaded = await downloadFromFTP(filename, filePath);
      if (!downloaded) {
        console.log(`❌ Файл не найден ни локально, ни на FTP: ${filename}`);
        return res.status(404).json({ error: 'Файл не найден' });
      }
      console.log(`✅ Файл восстановлен с FTP: ${filename}`);
    } else {
      console.log(`📄 Файл найден локально: ${filename}`);
    }
    
    const mimeType = getMimeType(filename);
    const fileSize = fs.statSync(filePath).size;
    const originalName = req.query.original || filename;
    
    console.log(`📥 Файл: ${filename}, mode: ${mode}`);
    
    // Предпросмотр (inline) или скачивание (attachment)
    const disposition = mode === 'preview' ? 'inline' : 'attachment';
    
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(originalName)}"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    
    fileStream.on('error', (error) => {
      console.error('❌ Ошибка чтения файла:', error);
      res.status(500).end();
    });
    
  } catch (error) {
    console.error('❌ Ошибка при скачивании файла:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 📊 СТАТИСТИКА

// Информация о сервере (требуется токен)
app.get('/api/server-info', authenticateToken, async (req, res) => {
  try {
    const docCount = dbGet("SELECT COUNT(*) as count FROM documents");
    const visibleCount = dbGet("SELECT COUNT(*) as count FROM documents WHERE is_visible = 1");
    
    let uploadsSize = 0;
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      for (const file of files) {
        const stat = fs.statSync(path.join(uploadsDir, file));
        if (stat.isFile()) uploadsSize += stat.size;
      }
    }
    
    res.json({
      documents: {
        total: docCount.count,
        visible: visibleCount.count,
        hidden: docCount.count - visibleCount.count
      },
      storage: {
        uploads: uploadsSize
      },
      server: {
        uptime: process.uptime(),
        nodeVersion: process.version
      }
    });
  } catch (error) {
    console.error('❌ Ошибка получения статистики:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 🔐 FIXED: Корневой эндпоинт
app.get('/', (req, res) => {
  res.json({
    name: 'AutoMashinka API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      documents: 'GET /api/documents',
      download: 'GET /api/download/:filename',
      health: 'GET /api/health',
      login: 'POST /api/login'
    }
  });
});

// 🔐 FIXED: Проверка здоровья сервера
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    jwtSecret: JWT_SECRET ? 'Установлен' : 'Дефолтный'
  });
});

// 📁 СТАТИЧЕСКИЕ ФАЙЛЫ (с поддержкой FTP)
app.get('/uploads/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(uploadsDir, filename);
    
    // 📥 Если файла нет локально - пробуем скачать с FTP
    if (!fs.existsSync(filePath)) {
      console.log(`📥 Файл не найден локально (uploads), пробуем с FTP: ${filename}`);
      const downloaded = await downloadFromFTP(filename, filePath);
      if (!downloaded) {
        return res.status(404).send('Файл не найден');
      }
      console.log(`✅ Файл скачан с FTP: ${filename}`);
    }
    
    // Отдаем файл
    res.sendFile(filePath);
  } catch (error) {
    console.error('❌ Ошибка статики:', error);
    res.status(500).send('Ошибка сервера');
  }
});

// 🔄 Автоматическая синхронизация файлов с FTP при старте
async function syncFilesFromFTP() {
  console.log('🔄 Начинаем синхронизацию файлов с FTP...');
  
  const client = new FTPClient();
  
  try {
    await client.connect(FTP_CONFIG.host, FTP_CONFIG.port);
    await client.login(FTP_CONFIG.user, FTP_CONFIG.password);
    
    // Читаем список файлов из папки uploads (основные файлы)
    await client.cd(FTP_CONFIG.remotePath);
    const fileList = await client.list();
    console.log(`📂 Файлов на FTP: ${fileList.length}`);
    
    // Используем имена файлов напрямую (без UUID)
    // Файлы уже имеют нормальные имена на FTP
    console.log(`   📄 Используем имена файлов с FTP`);
    
    let downloaded = 0;
    let added = 0;
    
    // Очищаем таблицу документов и добавляем заново с FTP
    db.run('DELETE FROM documents');
    console.log('🗑️ Очищена таблица документов');
    
    for (const file of fileList) {
      const localPath = path.join(uploadsDir, file.name);
      
      // Скачиваем если нет локально
      if (!fs.existsSync(localPath)) {
        console.log(`📥 Скачиваю: ${file.name}`);
        await client.downloadTo(localPath, file.name);
        downloaded++;
      }
      
      // Используем имя файла как есть (без UUID)
      const originalName = file.name;
      
      // Title - это имя файла без расширения
      const title = originalName.replace(/\.[^/.]+$/, '') || 'Документ';
      
      console.log(`   → "${title}" (${file.name})`);
      
      db.run(
        `INSERT INTO documents (title, description, filename, original_name, file_size, file_type, is_visible) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [title, '', file.name, originalName, file.size, 'pdf', 1]
      );
      saveDatabase();
      console.log(`📝 Добавлен в БД: ${file.name} (${title})`);
      added++;
    }
    
    console.log(`✅ Синхронизация завершена: ${downloaded} файлов скачано, ${added} добавлено в БД`);
    return downloaded + added;
  } catch (error) {
    console.error('❌ Ошибка синхронизации при старте:', error.message);
    return 0;
  } finally {
    try {
      await client.close();
    } catch {}
  }
}

// 🔧 ТЕСТОВЫЙ ЭНДПОИНТ: Проверить документы в БД
app.get('/api/debug/documents', (req, res) => {
  try {
    const all = dbAll("SELECT id, title, filename, is_visible, file_type FROM documents");
    const visible = dbAll("SELECT id, title, filename, is_visible FROM documents WHERE is_visible = 1");
    
    res.json({ 
      total: all.length,
      visible: visible.length,
      documents: all
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔧 ТЕСТОВЫЙ ЭНДПОИНТ: Синхронизация всех файлов с FTP
app.get('/api/sync-ftp', async (req, res) => {
  try {
    const client = new FTPClient();
    
    await client.connect(FTP_CONFIG.host, FTP_CONFIG.port);
    await client.login(FTP_CONFIG.user, FTP_CONFIG.password);
    await client.cd(FTP_CONFIG.remotePath);
    
    const fileList = await client.list();
    console.log(`📂 Файлов на FTP: ${fileList.length}`);
    
    const results = [];
    for (const file of fileList) {
      const localPath = path.join(uploadsDir, file.name);
      
      if (!fs.existsSync(localPath)) {
        console.log(`📥 Скачиваю: ${file.name}`);
        await client.downloadTo(localPath, file.name);
        results.push({ name: file.name, status: 'downloaded' });
      } else {
        results.push({ name: file.name, status: 'exists' });
      }
    }
    
    await client.close();
    
    res.json({ 
      success: true, 
      files: results,
      total: fileList.length
    });
  } catch (error) {
    console.error('❌ Ошибка синхронизации:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🔐 FIXED: Логирование всех запросов (для отладки)
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Обработка ошибок 404 для API
app.use('/api/*', (req, res) => {
  console.log(`❌ API 404: ${req.method} ${req.path}`);
  res.status(404).json({
    error: 'API маршрут не найден',
    path: req.path
  });
});

// Общая обработка ошибок 404
app.use((req, res) => {
  console.log(`❌ 404: ${req.method} ${req.path}`);
  
  // Если клиент ожидает HTML (React приложение)
  if (req.accepts('html')) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>404 - Страница не найдена</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
          h1 { color: #333; }
          .api-info { background: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px auto; max-width: 600px; }
          .endpoint { margin: 5px 0; }
        </style>
      </head>
      <body>
        <h1>🚀 AutoSchool API Server</h1>
        <p>Это серверная часть приложения AutoSchool.</p>
        <div class="api-info">
          <h3>Доступные эндпоинты:</h3>
          <div class="endpoint"><strong>GET /api/documents</strong> - Публичные документы</div>
          <div class="endpoint"><strong>GET /api/download/:filename</strong> - Скачивание файлов</div>
          <div class="endpoint"><strong>POST /api/login</strong> - Вход в систему</div>
          <div class="endpoint"><strong>GET /api/health</strong> - Проверка здоровья сервера</div>
        </div>
        <p>Фронтенд приложения доступен по адресу: <a href="http://localhost:3000">http://localhost:3000</a></p>
      </body>
      </html>
    `);
  }
  
  // Если клиент ожидает JSON
  if (req.accepts('json')) {
    return res.status(404).json({
      error: 'Маршрут не найден',
      path: req.path,
      availableEndpoints: {
        root: 'GET /',
        documents: 'GET /api/documents',
        download: 'GET /api/download/:filename',
        health: 'GET /api/health'
      }
    });
  }
  
  // По умолчанию текст
  res.status(404).send('Маршрут не найден');
});

// Глобальный обработчик ошибок
app.use((err, req, res, next) => {
  console.error('❌ Глобальная ошибка:', err);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Файл слишком большой. Максимум 20MB' });
    }
    return res.status(400).json({ error: err.message });
  }
  
  res.status(500).json({
    error: 'Внутренняя ошибка сервера',
    message: err.message
  });
});

// 🔐 FIXED: Запуск сервера с информацией о JWT
app.listen(PORT, async () => {
  // 🔄 Синхронизируем файлы с FTP при старте
  await syncFilesFromFTP();
  
  console.log(`
🚀 Сервер запущен на http://localhost:${PORT}
📁 Файлы хранятся в: ${uploadsDir}
📊 API доступен по: http://localhost:${PORT}/api
🔐 JWT Secret: ${JWT_SECRET ? 'Установлен' : 'Используется дефолтный'}
👤 Админ: admin / admin123
⚡ Примеры запросов:
  GET  http://localhost:${PORT}/ - Информация о сервере
  GET  http://localhost:${PORT}/api/documents - Публичные документы
  GET  http://localhost:${PORT}/api/health - Проверка здоровья
  POST http://localhost:${PORT}/api/login - Вход в систему
  `);
});