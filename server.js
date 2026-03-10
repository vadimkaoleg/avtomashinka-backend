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
  remotePath: process.env.FTP_PATH || 'uploads/named'
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
    
    client.ftp.verbose = false;
    
    await client.connect(FTP_CONFIG.host, FTP_CONFIG.port);
    await client.login(FTP_CONFIG.user, FTP_CONFIG.password);
    
    // 🔧 ВАЖНО: Переключаем в бинарный режим для корректной передачи файлов
    await client.send('TYPE I');
    
    console.log(`✅ FTP подключение установлено (бинарный режим)`);
    
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
    
    // ✅ Проверяем что файл загрузился корректно - скачиваем обратно и проверяем размер
    const localStat = fs.statSync(localFilePath);
    const tempCheckPath = path.join(uploadsDir, `.check_${fileName}`);
    await client.downloadTo(tempCheckPath, fileName);
    
    if (fs.existsSync(tempCheckPath)) {
      const remoteStat = fs.statSync(tempCheckPath);
      fs.unlinkSync(tempCheckPath); // Удаляем временный файл
      
      if (remoteStat.size !== localStat.size) {
        console.error(`❌ Размер файла на FTP не совпадает! Локально: ${localStat.size}, на FTP: ${remoteStat.size}`);
        // Удаляем файл с FTP если размер не совпал
        try {
          await client.remove(fileName);
        } catch {}
        return false;
      }
      console.log(`   ✅ Проверка целостности прошла: ${localStat.size} байт`);
    }
    
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

// Функция скачивания файла с FTP в буфер (без записи на диск)
async function downloadFileToBuffer(fileName) {
  const client = new FTPClient();
  
  try {
    console.log(`   📥 Скачивание в буфер с FTP: ${fileName}...`);
    
    client.ftp.verbose = false;
    
    await client.connect(FTP_CONFIG.host, FTP_CONFIG.port);
    await client.login(FTP_CONFIG.user, FTP_CONFIG.password);
    
    // 🔧 ВАЖНО: Переключаем в бинарный режим
    await client.send('TYPE I');
    
    try {
      await client.cd(FTP_CONFIG.remotePath);
    } catch {
      console.log(`   ⚠️ Не удалось войти в папку на FTP`);
      return null;
    }
    
    // 📥 Скачиваем файл в буфер
    const buffer = await client.downloadToBuffer(fileName);
    
    if (!buffer || buffer.length === 0) {
      console.error(`   ❌ Буфер пустой для: ${fileName}`);
      return null;
    }
    
    // 🔍 Проверяем заголовок
    const headerBytes = buffer.slice(0, 10);
    const headerStr = headerBytes.toString('ascii').substring(0, 5);
    console.log(`   🔍 Заголовок из буфера: "${headerStr}" (hex: ${headerBytes.toString('hex').substring(0, 20)})`);
    
    if (fileName.toLowerCase().endsWith('.pdf')) {
      if (!headerStr.startsWith('%PDF')) {
        console.error(`   ❌ PDF поврежден в буфере! Заголовок: "${headerStr}"`);
        return null;
      }
      console.log(`   ✅ PDF заголовок корректный в буфере`);
    }
    
    console.log(`   ✅ Файл скачан в буфер: ${buffer.length} bytes`);
    return buffer;
    
  } catch (error) {
    console.error(`   ❌ Ошибка скачивания в буфер: ${error.message}`);
    return null;
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
  
  return new Promise((resolve) => {
    (async () => {
      try {
        console.log(`📥 Скачивание с FTP: ${fileName}...`);
        console.log(`   FTP хост: ${FTP_CONFIG.host}:${FTP_CONFIG.port}, путь: ${FTP_CONFIG.remotePath}`);
        
        client.ftp.verbose = false;
        
        await client.connect(FTP_CONFIG.host, FTP_CONFIG.port);
        await client.login(FTP_CONFIG.user, FTP_CONFIG.password);
        
        // 🔧 ВАЖНО: Переключаем в бинарный режим для корректной передачи файлов
        await client.send('TYPE I');
        
        console.log(`   ✅ FTP подключен (бинарный режим)`);
        
        // Проверяем список файлов на FTP
        try {
          await client.cd(FTP_CONFIG.remotePath);
          const fileList = await client.list();
          console.log(`   📂 Файлов на FTP: ${fileList.length}`);
          const found = fileList.find(f => f.name === fileName);
          if (found) {
            console.log(`   ✅ Найден файл на FTP: ${fileName} (${found.size} bytes)`);
          } else {
            console.log(`   ⚠️ Файл НЕ найден на FTP!`);
          }
        } catch (cdErr) {
          console.log(`   ⚠️ Не удалось войти в папку:`, cdErr.message);
        }
        
        // 📥 Скачиваем файл напрямую в файл (а не в буфер)
        // Это гарантирует бинарную целостность
        await client.downloadTo(localPath, fileName);
        
        // Проверяем что файл скачался
        if (!fs.existsSync(localPath)) {
          console.error(`❌ Файл не скачался: ${fileName}`);
          resolve(false);
          return;
        }
        
        const stat = fs.statSync(localPath);
        console.log(`   ✅ Файл скачан: ${localPath}, размер: ${stat.size} bytes`);
        
        // Проверяем заголовок PDF (должен начинаться с %PDF)
        if (fileName.toLowerCase().endsWith('.pdf')) {
          const fd = fs.openSync(localPath, 'r');
          const headerBuffer = Buffer.alloc(5);
          fs.readSync(fd, headerBuffer, 0, 5, 0);
          fs.closeSync(fd);
          const headerCheck = headerBuffer.toString('ascii');
          console.log(`   🔍 Заголовок файла: "${headerCheck}" (ожидается "%PDF-")`);
          
          if (!headerCheck.startsWith('%PDF')) {
            console.error(`   ⚠️ ВНИМАНИЕ: Файл поврежден! Заголовок: "${headerCheck}"`);
            // Удаляем поврежденный файл
            fs.unlinkSync(localPath);
            resolve(false);
            return;
          }
        }
        
        console.log(`✅ Файл скачан с FTP: ${fileName} (${stat.size} bytes)`);
        resolve(true);
      } catch (error) {
        console.error('❌ Ошибка подключения к FTP:', error.message);
        resolve(false);
      } finally {
        try {
          await client.close();
        } catch {}
      }
    })();
  });
}

// Функция удаления файла с FTP
async function deleteFromFTP(fileName) {
  if (!ftpEnabled) {
    console.log(`⏭️ FTP отключен, пропускаем удаление: ${fileName}`);
    return false;
  }
  
  const client = new FTPClient();
  
  try {
    client.ftp.verbose = false;
    
    await client.connect(FTP_CONFIG.host, FTP_CONFIG.port);
    await client.login(FTP_CONFIG.user, FTP_CONFIG.password);
    
    // 🔧 ВАЖНО: Переключаем в бинарный режим
    await client.send('TYPE I');
    
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

// 📦 JSON БЭКАП (локально + FTP)

const BACKUP_FILE = 'backup.json';
const LOCAL_BACKUP_PATH = path.join(__dirname, BACKUP_FILE);

// Функция создания бэкапа (данные из БД)
function createBackupData() {
  return {
    timestamp: new Date().toISOString(),
    blocks: dbAll("SELECT * FROM blocks"),
    documents: dbAll("SELECT * FROM documents"),
    sections: dbAll("SELECT * FROM sections"),
    subsections: dbAll("SELECT * FROM subsections"),
    admin_users: dbAll("SELECT id, username, created_at FROM admin_users")
  };
}

// Функция восстановления данных из бэкапа
function restoreFromBackup(backup) {
  if (backup.blocks && backup.blocks.length > 0) {
    db.run("DELETE FROM blocks");
    for (const block of backup.blocks) {
      const itemsJson = block.items ? JSON.stringify(block.items) : null;
      db.run(
        `INSERT INTO blocks (id, name, title, subtitle, content, button_text, button_link, image, items, is_visible, updated_at, map_address) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          block.id, block.name,
          block.title || '', block.subtitle || '', block.content || '',
          block.button_text || '', block.button_link || '', block.image || '',
          itemsJson, block.is_visible ? 1 : 0,
          block.updated_at || new Date().toISOString(),
          block.map_address || ''
        ]
      );
    }
    console.log(`✅ Восстановлено ${backup.blocks.length} блоков (с map_address)`);
  }
      
  if (backup.sections && backup.sections.length > 0) {
    db.run("DELETE FROM sections");
    for (const section of backup.sections) {
      db.run(
        `INSERT INTO sections (id, name, sort_order, is_visible, created_at) VALUES (?, ?, ?, ?, ?)`,
        [section.id, section.name, section.sort_order || 0, section.is_visible ? 1 : 0, section.created_at]
      );
    }
    console.log(`✅ Восстановлено ${backup.sections.length} разделов`);
  }
      
  if (backup.subsections && backup.subsections.length > 0) {
    db.run("DELETE FROM subsections");
    for (const subsection of backup.subsections) {
      db.run(
        `INSERT INTO subsections (id, section_id, name, sort_order, is_visible, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [subsection.id, subsection.section_id, subsection.name, subsection.sort_order || 0, subsection.is_visible ? 1 : 0, subsection.created_at]
      );
    }
    console.log(`✅ Восстановлено ${backup.subsections.length} подразделов`);
  }
    
  // 📄 Восстановление документов с section_id и subsection_id
  // ВАЖНО: Пропускаем .sqlite и .json файлы
  if (backup.documents && backup.documents.length > 0) {
    db.run("DELETE FROM documents");
    let restoredCount = 0;
    for (const doc of backup.documents) {
      // Пропускаем системные файлы
      if (doc.filename && (doc.filename.endsWith('.sqlite') || doc.filename.endsWith('.json'))) {
        console.log(`   ⏭️ Пропущен системный файл: ${doc.filename}`);
        continue;
      }
      db.run(
        `INSERT INTO documents (id, title, description, filename, original_name, file_size, file_type, is_visible, sort_order, created_at, section_id, subsection_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          doc.id, doc.title, doc.description || '', doc.filename, doc.original_name || '',
          doc.file_size || 0, doc.file_type || 'pdf', doc.is_visible ? 1 : 0,
          doc.sort_order || 0, doc.created_at || new Date().toISOString(),
          doc.section_id, doc.subsection_id
        ]
      );
      restoredCount++;
    }
    console.log(`✅ Восстановлено ${restoredCount} документов (с разделами)`);
  }
      
  saveDatabase();
}

// Сохранить бэкап (локально + на FTP)
async function saveBackupToFTP() {
  const backup = createBackupData();
  
  // Преобразуем items в blocks для JSON
  const backupForJson = {
    ...backup,
    blocks: backup.blocks.map(block => ({
      ...block,
      items: block.items ? JSON.parse(block.items) : null
    }))
  };
  
  const backupJson = JSON.stringify(backupForJson, null, 2);
  
  // 📁 Всегда сохраняем локально
  fs.writeFileSync(LOCAL_BACKUP_PATH, backupJson, 'utf8');
  console.log(`💾 JSON бэкап сохранен локально: ${backupJson.length} байт`);
  
  // 📤 Если FTP доступен - загружаем
  if (ftpEnabled) {
    const client = new FTPClient();
    try {
      client.ftp.verbose = false;
      await client.connect(FTP_CONFIG.host, FTP_CONFIG.port);
      await client.login(FTP_CONFIG.user, FTP_CONFIG.password);
      await client.send('TYPE I');
    
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
      
      await client.uploadFrom(LOCAL_BACKUP_PATH, BACKUP_FILE);
      console.log(`📤 JSON бэкап загружен на FTP`);
      return true;
    } catch (error) {
      console.error('❌ Ошибка загрузки бэкапа на FTP:', error.message);
      return false;
    } finally {
      try { await client.close(); } catch {}
    }
  }
  
  return true;
}

// ============================================
// НОВЫЕ ФУНКЦИИ: Сохранение и загрузка SQLite БД на FTP
// ============================================

const DB_FILE = 'database.sqlite';
const LOCAL_DB_PATH = path.join(__dirname, DB_FILE);

// 📤 Сохранить базу данных SQLite на FTP
async function saveDatabaseToFTP() {
  if (!fs.existsSync(LOCAL_DB_PATH)) {
    console.log('⏭️ Локальная БД не найдена, пропускаем сохранение');
    return false;
  }
  
  const localStat = fs.statSync(LOCAL_DB_PATH);
  console.log(`💾 Сохранение БД на FTP: ${localStat.size} байт...`);

  if (!ftpEnabled) {
    console.log('⏭️ FTP отключен, пропускаем сохранение БД');
    return false;
  }

  const client = new FTPClient();
  try {
    client.ftp.verbose = false;
    await client.connect(FTP_CONFIG.host, FTP_CONFIG.port);
    await client.login(FTP_CONFIG.user, FTP_CONFIG.password);
    await client.send('TYPE I');
    
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

    await client.uploadFrom(LOCAL_DB_PATH, DB_FILE);
    console.log('💾 База данных сохранена на FTP');
    return true;
  } catch (error) {
    console.error('❌ Ошибка сохранения БД на FTP:', error.message);
    return false;
  } finally {
    try { await client.close(); } catch {}
  }
}

// 📥 Загрузить базу данных SQLite с FTP
async function loadDatabaseFromFTP() {
  if (!ftpEnabled) {
    console.log('⏭️ FTP отключен, пропускаем загрузку БД');
    return false;
  }

  const client = new FTPClient();
  const tempPath = path.join(__dirname, 'database_ftp_temp.sqlite');

  try {
    client.ftp.verbose = false;
    await client.connect(FTP_CONFIG.host, FTP_CONFIG.port);
    await client.login(FTP_CONFIG.user, FTP_CONFIG.password);
    await client.send('TYPE I');

    try {
      await client.cd(FTP_CONFIG.remotePath);
    } catch {
      console.log('⚠️ Папка на FTP не найдена');
      return false;
    }

    const fileList = await client.list();
    const dbFile = fileList.find(f => f.name === DB_FILE);

    if (!dbFile) {
      console.log('📋 База данных на FTP не найдена');
      return false;
    }

    console.log(`📥 Найдена БД на FTP: ${dbFile.size} байт`);

    // Скачиваем во временный файл
    await client.downloadTo(tempPath, DB_FILE);

    if (!fs.existsSync(tempPath)) {
      console.error('❌ Не удалось скачать БД с FTP');
      return false;
    }

    const ftpStat = fs.statSync(tempPath);
    const localStat = fs.existsSync(LOCAL_DB_PATH) ? fs.statSync(LOCAL_DB_PATH) : null;

    // Если FTP версия новее (по размеру) или локальной нет — используем её
    // Также если размеры совпадают, но хотим синхронизировать
    if (!localStat || ftpStat.size > localStat.size || ftpStat.size === localStat.size) {
      // Удаляем старую и перемещаем новую
      if (fs.existsSync(LOCAL_DB_PATH)) {
        fs.unlinkSync(LOCAL_DB_PATH);
      }
      fs.copyFileSync(tempPath, LOCAL_DB_PATH);
      fs.unlinkSync(tempPath);
      console.log('💾 База данных загружена с FTP');
      return true;
    }

    console.log('📋 Локальная БД актуальна, используем её');
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    return false;
  } catch (error) {
    console.warn('⚠️ Не удалось загрузить БД с FTP:', error.message);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    return false;
  } finally {
    try { await client.close(); } catch {}
  }
}

// ============================================
// НОВЫЕ ФУНКЦИИ: Экспорт JSON для фронтенда
// ============================================

const DATA_JSON_FILE = 'site-data.json';
const LOCAL_DATA_JSON_PATH = path.join(__dirname, DATA_JSON_FILE);

// 📁 Прямой URL для файлов на webnames
const FILES_BASE_URL = 'https://avmashinka.ru/uploads/named';

// 📦 Создать JSON с данными для фронтенда
function createSiteDataJSON() {
  const blocks = dbAll("SELECT * FROM blocks");
  
  // 🧹 Получаем все документы с актуальными данными о разделах
  // Используем MAX(id) чтобы получить самую свежую запись для каждого filename
  let documents = dbAll(`
    SELECT d.*, s.name as section_name, sub.name as subsection_name 
    FROM documents d
    LEFT JOIN sections s ON d.section_id = s.id
    LEFT JOIN subsections sub ON d.subsection_id = sub.id
    WHERE d.filename NOT LIKE '%.json' AND d.filename NOT LIKE '%.sqlite'
    AND d.id = (
      SELECT MAX(d2.id) FROM documents d2 
      WHERE d2.filename = d.filename
    )
    ORDER BY d.sort_order ASC, d.created_at DESC
  `);

  console.log(`📦 JSON: получено ${documents.length} документов с актуальными section_id`);

  const sections = dbAll("SELECT * FROM sections");
  const subsections = dbAll("SELECT * FROM subsections");

  // Парсим JSON-поля в blocks
  const parsedBlocks = blocks.map(block => ({
    ...block,
    items: block.items ? JSON.parse(block.items) : null,
    is_visible: Boolean(block.is_visible)
  }));

  // Добавляем прямые ссылки на файлы
  const docsWithUrls = documents.map(doc => ({
    ...doc,
    downloadUrl: `${FILES_BASE_URL}/${encodeURIComponent(doc.filename)}`,
    fileUrl: `${FILES_BASE_URL}/${encodeURIComponent(doc.filename)}`,
    is_visible: Boolean(doc.is_visible)
  }));

  // Группируем подразделы по разделам
  const sectionsWithSubsections = sections.map(section => ({
    ...section,
    subsections: subsections
      .filter(sub => sub.section_id === section.id)
      .map(sub => ({ ...sub, is_visible: Boolean(sub.is_visible) })),
    is_visible: Boolean(section.is_visible)
  }));

  return {
    version: '1.0',
    timestamp: new Date().toISOString(),
    generated: new Date().toISOString(),
    blocks: parsedBlocks,
    documents: docsWithUrls,
    sections: sectionsWithSubsections
  };
}

// 📤 Загрузить JSON с данными на FTP
async function uploadDataJSONToFTP() {
  const data = createSiteDataJSON();
  const jsonContent = JSON.stringify(data, null, 2);

  // Сохраняем локально
  fs.writeFileSync(LOCAL_DATA_JSON_PATH, jsonContent, 'utf8');
  console.log(`💾 JSON данных сохранен локально: ${jsonContent.length} байт`);

  if (!ftpEnabled) {
    console.log('⏭️ FTP отключен, пропускаем загрузку JSON');
    return false;
  }

  const client = new FTPClient();
  try {
    client.ftp.verbose = false;
    await client.connect(FTP_CONFIG.host, FTP_CONFIG.port);
    await client.login(FTP_CONFIG.user, FTP_CONFIG.password);
    await client.send('TYPE I');
    
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
    
    await client.uploadFrom(LOCAL_DATA_JSON_PATH, DATA_JSON_FILE);
    console.log('📤 JSON данных загружен на FTP');
    return true;
  } catch (error) {
    console.error('❌ Ошибка загрузки JSON на FTP:', error.message);
    return false;
  } finally {
    try { await client.close(); } catch {}
  }
}

// 📥 Экспортировать и загрузить данные (обёртка для вызова после изменений)
async function syncDataToFTP() {
  // Сохраняем БД на FTP
  await saveDatabaseToFTP();
  // Загружаем JSON на FTP
  await uploadDataJSONToFTP();
}

// 📊 Получить ВСЕ данные одним запросом (для фронтенда с fallback на FTP)
app.get('/api/alldata', async (req, res) => {
  try {
    const data = createSiteDataJSON();
    res.json(data);
  } catch (error) {
    console.error('❌ Ошибка получения всех данных:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================
// Конец новых функций
// ============================================

// Загрузить бэкап при старте (локальный + FTP, выбираем свежий)
async function loadBackupFromFTP() {
  const client = new FTPClient();
  
  let localTimestamp = null;
  let ftpTimestamp = null;
  
  // 📥 Проверяем локальный бэкап
  if (fs.existsSync(LOCAL_BACKUP_PATH)) {
    try {
      const localBackup = JSON.parse(fs.readFileSync(LOCAL_BACKUP_PATH, 'utf8'));
      localTimestamp = localBackup.timestamp;
      console.log(`💾 Локальный бэкап: ${localTimestamp}`);
    } catch (e) {
      console.warn('⚠️ Локальный бэкап поврежден');
    }
  }
  
  // 📥 Проверяем FTP бэкап
  if (ftpEnabled) {
    try {
      client.ftp.verbose = false;
      await client.connect(FTP_CONFIG.host, FTP_CONFIG.port);
      await client.login(FTP_CONFIG.user, FTP_CONFIG.password);
      await client.send('TYPE I');
      
      try {
        await client.cd(FTP_CONFIG.remotePath);
        const fileList = await client.list();
        const backupFile = fileList.find(f => f.name === BACKUP_FILE);
        
        if (backupFile) {
          // Скачиваем чтобы прочитать timestamp
          const tempPath = path.join(__dirname, 'backup_temp.json');
          await client.downloadTo(tempPath, BACKUP_FILE);
          
          if (fs.existsSync(tempPath)) {
            const ftpBackup = JSON.parse(fs.readFileSync(tempPath, 'utf8'));
            ftpTimestamp = ftpBackup.timestamp;
            console.log(`📤 FTP бэкап: ${ftpTimestamp}`);
            fs.unlinkSync(tempPath); // Удаляем временный файл
          }
        }
      } catch (e) {
        console.warn('⚠️ Не удалось проверить FTP бэкап:', e.message);
      }
    } catch (error) {
      console.warn('⚠️ FTP недоступен при проверке бэкапа:', error.message);
    } finally {
      try { await client.close(); } catch {}
    }
  }
  
  // 🎯 Определяем какой бэкап использовать (свежий)
  let restoreFromFtp = false;
  
  if (!localTimestamp && !ftpTimestamp) {
    console.log('📋 Бэкапов нет, используем текущую БД');
    return false;
  }
  
  if (localTimestamp && !ftpTimestamp) {
    console.log('📋 Только локальный бэкап, используем его');
    restoreFromFtp = false;
  } else if (!localTimestamp && ftpTimestamp) {
    console.log('📋 Только FTP бэкап, используем его');
    restoreFromFtp = true;
  } else {
    // Оба есть - выбираем свежий
    const localDate = new Date(localTimestamp);
    const ftpDate = new Date(ftpTimestamp);
    
    if (ftpDate > localDate) {
      console.log('📋 FTP бэкап новее, используем его');
      restoreFromFtp = true;
    } else {
      console.log('📋 Локальный бэкап новее/одинаковый, используем его');
      restoreFromFtp = false;
    }
  }
  
  // 🔄 Восстанавливаем данные
  try {
    if (restoreFromFtp && ftpEnabled) {
      // Скачиваем с FTP
      const client2 = new FTPClient();
      try {
        client2.ftp.verbose = false;
        await client2.connect(FTP_CONFIG.host, FTP_CONFIG.port);
        await client2.login(FTP_CONFIG.user, FTP_CONFIG.password);
        await client2.send('TYPE I');
        await client2.cd(FTP_CONFIG.remotePath);
        await client2.downloadTo(LOCAL_BACKUP_PATH, BACKUP_FILE);
        
        const backup = JSON.parse(fs.readFileSync(LOCAL_BACKUP_PATH, 'utf8'));
        restoreFromBackup(backup);
        console.log('✅ Бэкап восстановлен с FTP');
        return true;
      } finally {
        try { await client2.close(); } catch {}
      }
    } else {
      // Используем локальный
      const backup = JSON.parse(fs.readFileSync(LOCAL_BACKUP_PATH, 'utf8'));
      restoreFromBackup(backup);
      console.log('✅ Бэкап восстановлен локально');
      return true;
    }
  } catch (error) {
    console.error('❌ Ошибка восстановления бэкапа:', error.message);
    return false;
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

  // 📁 Таблица разделов
  db.run(`
    CREATE TABLE IF NOT EXISTS sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_visible INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 📁 Таблица подразделов
  db.run(`
    CREATE TABLE IF NOT EXISTS subsections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_visible INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
    )
  `);

  // Добавляем колонки section_id и subsection_id если их нет (миграция)
  try {
    db.run("ALTER TABLE documents ADD COLUMN section_id INTEGER");
  } catch (e) {}
  try {
    db.run("ALTER TABLE documents ADD COLUMN subsection_id INTEGER");
  } catch (e) {}

  // Заполняем разделами по умолчанию если пусто
  const sectionsCount = db.exec("SELECT COUNT(*) FROM sections");
  if (sectionsCount.length === 0 || sectionsCount[0].values[0][0] === 0) {
    const defaultSections = [
      { name: 'Уставные документы', sort_order: 0 },
      { name: 'Образовательные программы', sort_order: 1 },
      { name: 'Документы для учеников', sort_order: 2 },
      { name: 'Информация для родителей', sort_order: 3 }
    ];
    
    for (const section of defaultSections) {
      dbRun("INSERT INTO sections (name, sort_order, is_visible) VALUES (?, ?, 1)", [section.name, section.sort_order]);
    }
    console.log('✅ Созданы разделы по умолчанию');
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
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      map_address TEXT
    )
  `);

  // Миграция: добавляем колонку map_address если её нет
  try {
    db.run("ALTER TABLE blocks ADD COLUMN map_address TEXT");
  } catch (e) {
    // Колонка уже существует
  }

  // Миграция: добавляем колонку legal_info если её нет (в items хранится)
  // Для блока documents legal_info хранится как JSON в поле items
  // Пример: {"legal_info": "текст юридической информации"}
  console.log('✅ Миграция legal_info: хранится в items как JSON');

  // Заполняем таблицу блоков начальными данными
  const defaultBlocks = [
    { name: 'hero', title: 'Мы не просто автошкола.', subtitle: 'Мы — Академия будущих водителей!', content: 'Автошкола "Машинка" предлагает качественное обучение вождению с опытными инструкторами. Получите права быстро и надежно!', button_text: 'Записаться сейчас', button_link: 'contact', is_visible: 1 },
    { name: 'about', title: 'О нас', subtitle: '', content: 'Мы работаем уже более 10 лет и помогли тысячам учеников получить водительские права. Наши инструкторы — профессионалы с многолетним стажем.', button_text: '', button_link: '', is_visible: 1 },
    { name: 'advantages', title: 'Почему выбирают нас', subtitle: '', content: '', button_text: '', button_link: '', items: JSON.stringify([{ title: 'Опытные инструкторы', description: 'Стаж работы от 5 лет' },{ title: 'Современные авто', description: 'Новые и безопасные автомобили' },{ title: 'Гибкий график', description: 'Обучение в удобное время' }]), is_visible: 1 },
    { name: 'courses', title: 'Наши курсы', subtitle: '', content: '', button_text: '', button_link: '', items: JSON.stringify([{ title: 'Категория B', price: 'от 25 000 ₽', description: 'Обучение на легковой автомобиль' },{ title: 'Категория A', price: 'от 15 000 ₽', description: 'Обучение на мотоцикл' },{ title: 'Категория C', price: 'от 35 000 ₽', description: 'Обучение на грузовой автомобиль' }]), is_visible: 1 },
    { name: 'contact', title: 'Связаться с нами', subtitle: 'Оставьте заявку', content: 'Заполните форму и мы свяжемся с вами в ближайшее время', button_text: 'Отправить заявку', button_link: '', is_visible: 1 },
    { name: 'footer', title: '', subtitle: '', content: '© 2024 Автошкола "Машинка". Все права защищены.', button_text: '', button_link: '', items: JSON.stringify([{ title: 'Телефон', value: '+7 (999) 123-45-67' },{ title: 'Email', value: 'info@mashinka.ru' },{ title: 'Адрес', value: 'г. Москва, ул. Примерная, д. 1' }]), is_visible: 1 },
    { name: 'documents', title: 'Сведения об образовательной организации', subtitle: '', content: '', button_text: '', button_link: '', items: JSON.stringify({ legal_info: '' }), is_visible: 1 }
  ];

  for (const block of defaultBlocks) {
    const result = db.exec("SELECT id FROM blocks WHERE name = ?", [block.name]);
    if (result.length === 0 || result[0].values.length === 0) {
      db.run(
        "INSERT INTO blocks (name, title, subtitle, content, button_text, button_link, items, is_visible) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          block.name,
          block.title,
          block.subtitle || '',
          block.content || '',
          block.button_text || '',
          block.button_link || '',
          block.items || null,
          block.is_visible || 1
        ]
      );
      console.log(`✅ Создан блок: ${block.name}`);
    }
  }
      
  // МИГРАЦИЯ: Добавляем блок documents если его нет (для существующих БД)
  const docsBlock = db.exec("SELECT id FROM blocks WHERE name = 'documents'");
  if (docsBlock.length === 0 || docsBlock[0].values.length === 0) {
    db.run(
      "INSERT INTO blocks (name, title, subtitle, content, button_text, button_link, items, is_visible) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ['documents', 'Сведения об образовательной организации', '', '', '', '', JSON.stringify({ legal_info: '' }), 1]
    );
    console.log('✅ Миграция: создан блок documents');
  }
  
  // Проверим все блоки
  const allBlocks = db.exec("SELECT id, name, is_visible FROM blocks");
  console.log('📦 Блоки в БД:', allBlocks);

  // Создаем начального администратора (или обновляем пароль)
  const adminResult = db.exec("SELECT * FROM admin_users WHERE username = 'admin'");
  const hash = bcrypt.hashSync('e67bBjNy', 10);
  
  if (adminResult.length === 0 || adminResult[0].values.length === 0) {
    db.run(
      "INSERT INTO admin_users (username, password_hash) VALUES (?, ?)",
      ['admin', hash]
    );
    console.log('✅ Создан администратор: admin / admin123');
    console.log('✅ Создан администратор: admin / e67bBjNy');
  } else {
    db.run(
      "UPDATE admin_users SET password_hash = ? WHERE username = 'admin'",
      [hash]
    );
    console.log('🔄 Обновлен пароль администратора: admin / admin123');
    console.log('🔄 Обновлен пароль администратора: admin / e67bBjNy');
  }
    
  // Сохраняем БД
  saveDatabase();
    
  console.log('✅ База данных инициализирована');
  console.log(`🔐 JWT Secret: ${JWT_SECRET ? 'Установлен' : 'Используется дефолтный'}`);

  // 📥 Загружаем БД SQLite с FTP при старте (если есть)
  // ВАЖНО: Всегда пытаемся загрузить с FTP если там есть данные
  console.log('📥 Проверяем наличие БД на FTP...');
  try {
    const dbRestored = await loadDatabaseFromFTP();
    if (dbRestored) {
      console.log('✅ База данных загружена с FTP');
      // Перезагружаем данные в память
      const fileBuffer = fs.readFileSync(LOCAL_DB_PATH);
      db = new SQL.Database(fileBuffer);
      
      // Проверим что данные загрузились
      const blocks = db.exec("SELECT COUNT(*) FROM blocks");
      console.log(`   📊 Загружено блоков: ${blocks[0]?.values[0][0] || 0}`);
      
      // 🧹 Очистка дубликатов и системных файлов после загрузки с FTP
      const dupCheck = db.exec("SELECT filename, COUNT(*) as cnt FROM documents GROUP BY filename HAVING cnt > 1");
      if (dupCheck.length > 0 && dupCheck[0].values.length > 0) {
        console.log(`🔧 Найдено дубликатов: ${dupCheck[0].values.length}, удаляем...`);
        // Удаляем дубликаты, оставляя только первый
        db.run(`
          DELETE FROM documents 
          WHERE id NOT IN (
            SELECT MIN(id) FROM documents GROUP BY filename
          )
        `);
        console.log('✅ Дубликаты удалены');
        saveDatabase();
      }
      
      // 🧹 Удаляем системные файлы из documents
      const sysFiles = db.exec("SELECT COUNT(*) FROM documents WHERE filename LIKE '%.sqlite' OR filename LIKE '%.json'");
      if (sysFiles.length > 0 && sysFiles[0].values[0][0] > 0) {
        db.run("DELETE FROM documents WHERE filename LIKE '%.sqlite' OR filename LIKE '%.json'");
        console.log('✅ Системные файлы удалены из documents');
        saveDatabase();
      }
    } else {
      console.log('📋 БД на FTP не найдена или не требует обновления, используем локальную');
    }
  } catch (error) {
    console.warn('⚠️ Не удалось загрузить БД с FTP:', error.message);
  }

  // 📥 Загружаем бэкап с FTP при старте (если есть) - как резерв
  // ВАЖНО: Не восстанавливаем из бэкапа если БД уже была загружена с FTP
  // (бэкап может содержать устаревшие данные)
  console.log('📥 Проверяем наличие бэкапа на FTP...');
  const dbWasLoadedFromFTP = fs.existsSync(LOCAL_DB_PATH); // БД уже загружена
  if (!dbWasLoadedFromFTP) {
    // Только если БД не была загружена - пробуем бэкап
    try {
      const backupRestored = await loadBackupFromFTP();
      if (backupRestored) {
        console.log('✅ Данные восстановлены из бэкапа');
      } else {
        console.log('📋 Используем текущую базу данных');
      }
    } catch (error) {
      console.warn('⚠️ Не удалось загрузить бэкап:', error.message);
    }
  } else {
    console.log('📋 БД уже загружена, пропускаем восстановление из бэкапа');
  }
    
  // 📤 Выгружаем JSON с данными на FTP для фронтенда
  console.log('📤 Экспортируем данные для фронтенда...');
  try {
    await uploadDataJSONToFTP();
  } catch (error) {
    console.warn('⚠️ Не удалось экспортировать данные:', error.message);
  }

  // 🔄 Синхронизируем файлы с FTP (добавляем новые документы)
  console.log('🔄 Запускаем синхронизацию файлов с FTP...');
  try {
    await syncFilesFromFTP();
  } catch (error) {
    console.warn('⚠️ Не удалось синхронизировать файлы:', error.message);
  }
  
  console.log('✅ Инициализация БД завершена');
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

// 🔐 Смена пароля администратора
app.put('/api/admin/password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Заполните все поля' });
    }
    
    if (newPassword.length < 4) {
      return res.status(400).json({ error: 'Новый пароль должен быть минимум 4 символа' });
    }
    
    // Проверяем текущий пароль
    const user = dbGet("SELECT * FROM admin_users WHERE username = ?", [req.user.username]);
    
    const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Неверный текущий пароль' });
    }
    
    // Обновляем пароль
    const newHash = bcrypt.hashSync(newPassword, 10);
    dbRun("UPDATE admin_users SET password_hash = ? WHERE username = ?", [newHash, req.user.username]);
    
    console.log(`✅ Сменён пароль для пользователя: ${req.user.username}`);
    
    res.json({ success: true, message: 'Пароль успешно изменён' });
  } catch (error) {
    console.error('❌ Ошибка смены пароля:', error);
    res.status(500).json({ error: 'Ошибка при смене пароля' });
  }
});

// 📁 УПРАВЛЕНИЕ ДОКУМЕНТАМИ

// Получить все документы (публичный доступ) - БЕЗ аутентификации
app.get('/api/documents', async (req, res) => {
  try {
    // Получаем документы с информацией о разделах
    // Исключаем .json и .sqlite файлы
    // Группируем по filename чтобы убрать дубликаты
    const documents = dbAll(`
      SELECT d.*, s.name as section_name, sub.name as subsection_name 
      FROM documents d
      LEFT JOIN sections s ON d.section_id = s.id
      LEFT JOIN subsections sub ON d.subsection_id = sub.id
      WHERE d.is_visible = 1 AND d.filename NOT LIKE '%.json' AND d.filename NOT LIKE '%.sqlite'
      GROUP BY d.filename
      ORDER BY MIN(d.id) ASC, d.sort_order ASC, d.created_at DESC
    `);
    
    // Используем прямые ссылки на webnames (минуя Render.com)
    const docsWithUrls = documents.map(doc => ({
      ...doc,
      downloadUrl: `${FILES_BASE_URL}/${encodeURIComponent(doc.filename)}`,
      fileUrl: `${FILES_BASE_URL}/${encodeURIComponent(doc.filename)}`,
      is_visible: Boolean(doc.is_visible),
      section_name: doc.section_name || null,
      subsection_name: doc.subsection_name || null
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
  // Получаем документы с информацией о разделах
    // Исключаем .json и .sqlite файлы
    // Группируем по filename чтобы убрать дубликаты
    const documents = dbAll(`
      SELECT d.*, s.name as section_name, sub.name as subsection_name 
      FROM documents d
      LEFT JOIN sections s ON d.section_id = s.id
      LEFT JOIN subsections sub ON d.subsection_id = sub.id
      WHERE d.filename NOT LIKE '%.json' AND d.filename NOT LIKE '%.sqlite'
      GROUP BY d.filename
      ORDER BY MIN(d.id) ASC, d.sort_order ASC, d.created_at DESC
    `);

    // Логируем первый документ для отладки
    if (documents.length > 0) {
      console.log('🔍 DOCS LOAD - Первый документ:', {
        id: documents[0].id,
        title: documents[0].title,
        section_id: documents[0].section_id,
        subsection_id: documents[0].subsection_id,
        section_name: documents[0].section_name
      });
    }

    // Используем прямые ссылки на webnames
    const docsWithUrls = documents.map(doc => ({
      ...doc,
      downloadUrl: `${FILES_BASE_URL}/${encodeURIComponent(doc.filename)}`,
      fileUrl: `${FILES_BASE_URL}/${encodeURIComponent(doc.filename)}`,
      is_visible: Boolean(doc.is_visible),
      section_name: doc.section_name || null,
      subsection_name: doc.subsection_name || null
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
    
    // 📦 Сохраняем бэкап на FTP
    await syncDataToFTP();

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
    const { title, description, is_visible = 'true', section_id, subsection_id } = req.body;
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
      
      // Преобразуем section_id и subsection_id в числа или null
      console.log('🔍 UPLOAD DOC - Входящие данные:', { section_id, subsection_id, typeOfSectionId: typeof section_id });
      
      const parsedSectionId = section_id !== null && section_id !== undefined && section_id !== '' ? parseInt(section_id, 10) : null;
      const parsedSubsectionId = subsection_id !== null && subsection_id !== undefined && subsection_id !== '' ? parseInt(subsection_id, 10) : null;
      
      console.log('🔍 UPLOAD DOC - После преобразования:', { parsedSectionId, parsedSubsectionId });
      
      const result = dbRun(
        `INSERT INTO documents 
         (title, description, filename, original_name, file_size, file_type, is_visible, section_id, subsection_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fileTitle,
          description ? description.trim() : null,
          file.filename,
          file.originalname,
          file.size,
          fileType,
          is_visible === 'true' ? 1 : 0,
          parsedSectionId,
          parsedSubsectionId
        ]
      );
      
      console.log(`   📋 Документ привязан к разделу: ${parsedSectionId || 'нет'}, подразделу: ${parsedSubsectionId || 'нет'}`);
      
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
    
    // 📦 Сохраняем бэкап на FTP
    await syncDataToFTP();

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
    const { title, description, is_visible, section_id, subsection_id } = req.body;
    
    const existingDoc = dbGet("SELECT * FROM documents WHERE id = ?", [id]);
    if (!existingDoc) {
      return res.status(404).json({ error: 'Документ не найден' });
    }
    
    // Преобразуем section_id и subsection_id
    console.log('🔍 UPDATE DOC - Входящие данные:', { section_id, subsection_id, existingSectionId: existingDoc.section_id });
    
    const newSectionId = section_id !== undefined 
      ? (section_id !== null && section_id !== '' ? parseInt(section_id, 10) : null) 
      : existingDoc.section_id;
    const newSubsectionId = subsection_id !== undefined 
      ? (subsection_id !== null && subsection_id !== '' ? parseInt(subsection_id, 10) : null) 
      : existingDoc.subsection_id;
    
    console.log('🔍 UPDATE DOC - После преобразования:', { newSectionId, newSubsectionId });
    
    dbRun(
      `UPDATE documents 
       SET title = ?, description = ?, is_visible = ?, section_id = ?, subsection_id = ? 
       WHERE id = ?`,
      [
        title ? title.trim() : existingDoc.title,
        description !== undefined ? description.trim() : existingDoc.description,
        is_visible !== undefined ? (is_visible === 'true' ? 1 : 0) : existingDoc.is_visible,
        newSectionId,
        newSubsectionId,
        id
      ]
    );

    console.log(`✅ Обновлен документ ID: ${id}, раздел: ${newSectionId || 'нет'}, подраздел: ${newSubsectionId || 'нет'}`);
    
    // 📦 Сохраняем бэкап на FTP
    await syncDataToFTP();

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
    
    // 📦 Сохраняем бэкап на FTP
    await syncDataToFTP();

    res.json({ 
      success: true, 
      message: 'Документ удален' 
    });
    
  } catch (error) {
    console.error('❌ Ошибка удаления документа:', error);
    res.status(500).json({ error: 'Ошибка при удалении' });
  }
});

// 📁 УПРАВЛЕНИЕ РАЗДЕЛАМИ

// Получить все разделы (публичный)
app.get('/api/sections', async (req, res) => {
  try {
    const sections = dbAll("SELECT * FROM sections WHERE is_visible = 1 ORDER BY sort_order ASC");
    const subsections = dbAll("SELECT * FROM subsections WHERE is_visible = 1 ORDER BY sort_order ASC");
    
    // Группируем подразделы по разделам
    const sectionsWithSubsections = sections.map(section => ({
      ...section,
      subsections: subsections.filter(sub => sub.section_id === section.id),
      is_visible: Boolean(section.is_visible)
    }));
    
    res.json(sectionsWithSubsections);
  } catch (error) {
    console.error('❌ Ошибка получения разделов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить все разделы для админки
app.get('/api/admin/sections', authenticateToken, async (req, res) => {
  try {
    const sections = dbAll("SELECT * FROM sections ORDER BY sort_order ASC");
    const subsections = dbAll("SELECT * FROM subsections ORDER BY sort_order ASC");
    
    const sectionsWithSubsections = sections.map(section => ({
      ...section,
      subsections: subsections.filter(sub => sub.section_id === section.id),
      is_visible: Boolean(section.is_visible)
    }));
    
    res.json(sectionsWithSubsections);
  } catch (error) {
    console.error('❌ Ошибка получения разделов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создать раздел
app.post('/api/admin/sections', authenticateToken, async (req, res) => {
  try {
    const { name, is_visible = true } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Название раздела обязательно' });
    }
    
    const maxOrder = dbGet("SELECT MAX(sort_order) as max FROM sections");
    const newOrder = (maxOrder?.max || 0) + 1;
    
    const result = dbRun(
      "INSERT INTO sections (name, sort_order, is_visible) VALUES (?, ?, ?)",
      [name.trim(), newOrder, is_visible ? 1 : 0]
    );

    console.log(`✅ Создан раздел: ${name} (ID: ${result.lastID})`);
    
    // 📦 Сохраняем бэкап на FTP
    await syncDataToFTP();

    res.status(201).json({
      success: true, 
      id: result.lastID,
      message: 'Раздел создан'
    });
  } catch (error) {
    console.error('❌ Ошибка создания раздела:', error);
    res.status(500).json({ error: 'Ошибка при создании' });
  }
});

// Обновить раздел
app.put('/api/admin/sections/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, is_visible, sort_order } = req.body;
    
    const existing = dbGet("SELECT * FROM sections WHERE id = ?", [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Раздел не найден' });
    }
    
    dbRun(
      "UPDATE sections SET name = ?, is_visible = ?, sort_order = ? WHERE id = ?",
      [
        name ? name.trim() : existing.name,
        is_visible !== undefined ? (is_visible ? 1 : 0) : existing.is_visible,
        sort_order !== undefined ? sort_order : existing.sort_order,
        id
      ]
    );
    
    console.log(`✅ Обновлен раздел ID: ${id}`);
    
    // 📦 Сохраняем бэкап на FTP
    await syncDataToFTP();

    res.json({ success: true, message: 'Раздел обновлен' });
  } catch (error) {
    console.error('❌ Ошибка обновления раздела:', error);
    res.status(500).json({ error: 'Ошибка при обновлении' });
  }
});
  
// Удалить раздел
app.delete('/api/admin/sections/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Удаляем подразделы этого раздела
    dbRun("DELETE FROM subsections WHERE section_id = ?", [id]);
    
    // Убираем связь с документами
    dbRun("UPDATE documents SET section_id = NULL WHERE section_id = ?", [id]);
    dbRun("UPDATE documents SET subsection_id = NULL WHERE subsection_id IN (SELECT id FROM subsections WHERE section_id = ?)", [id]);
    
    // Удаляем раздел
    dbRun("DELETE FROM sections WHERE id = ?", [id]);
    
    console.log(`🗑️ Удален раздел ID: ${id}`);
    
    // 📦 Сохраняем бэкап на FTP
    await syncDataToFTP();

    res.json({ success: true, message: 'Раздел удален' });
  } catch (error) {
    console.error('❌ Ошибка удаления раздела:', error);
    res.status(500).json({ error: 'Ошибка при удалении' });
  }
});

// Создать подраздел
app.post('/api/admin/subsections', authenticateToken, async (req, res) => {
  try {
    const { section_id, name, is_visible = true } = req.body;
    
    if (!section_id) {
      return res.status(400).json({ error: 'ID раздела обязателен' });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Название подраздела обязательно' });
    }
    
    const section = dbGet("SELECT * FROM sections WHERE id = ?", [section_id]);
    if (!section) {
      return res.status(404).json({ error: 'Раздел не найден' });
    }
    
    const maxOrder = dbGet("SELECT MAX(sort_order) as max FROM subsections WHERE section_id = ?", [section_id]);
    const newOrder = (maxOrder?.max || 0) + 1;
    
    const result = dbRun(
      "INSERT INTO subsections (section_id, name, sort_order, is_visible) VALUES (?, ?, ?, ?)",
      [section_id, name.trim(), newOrder, is_visible ? 1 : 0]
    );

    console.log(`✅ Создан подраздел: ${name} (ID: ${result.lastID})`);
    
    // 📦 Сохраняем бэкап на FTP
    await syncDataToFTP();

    res.status(201).json({
      success: true, 
      id: result.lastID,
      message: 'Подраздел создан'
    });
  } catch (error) {
    console.error('❌ Ошибка создания подраздела:', error);
    res.status(500).json({ error: 'Ошибка при создании' });
  }
});

// Обновить подраздел
app.put('/api/admin/subsections/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, is_visible, sort_order, section_id } = req.body;
    
    const existing = dbGet("SELECT * FROM subsections WHERE id = ?", [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Подраздел не найден' });
    }
    
    dbRun(
      "UPDATE subsections SET name = ?, is_visible = ?, sort_order = ?, section_id = ? WHERE id = ?",
      [
        name ? name.trim() : existing.name,
        is_visible !== undefined ? (is_visible ? 1 : 0) : existing.is_visible,
        sort_order !== undefined ? sort_order : existing.sort_order,
        section_id !== undefined ? section_id : existing.section_id,
        id
      ]
    );

    console.log(`✅ Обновлен подраздел ID: ${id}`);
    
// 📦 Сохраняем бэкап на FTP
    await syncDataToFTP();

    res.json({ success: true, message: 'Подраздел обновлен' });
  } catch (error) {
    console.error('❌ Ошибка обновления подраздела:', error);
    res.status(500).json({ error: 'Ошибка при обновлении' });
  }
});

// 📥 СИНХРОНИЗАЦИЯ С FTP (для админки) - добавляет новые файлы, не удаляя существующие
app.post('/api/admin/sync-ftp', authenticateToken, async (req, res) => {
  try {
    console.log('🔄 Запрос синхронизации с FTP из админки...');
    
    if (!ftpEnabled) {
      return res.json({ 
        success: false, 
        message: 'FTP отключен в конфигурации',
        synced: false
      });
    }
    
    // Просто вызываем функцию синхронизации файлов (добавляет новые, не удаляя)
    const addedCount = await syncFilesFromFTP();
    
    const docCount = dbGet("SELECT COUNT(*) as count FROM documents");
    const visibleCount = dbGet("SELECT COUNT(*) as count FROM documents WHERE is_visible = 1");
    
    res.json({ 
      success: true,
      message: `Синхронизация завершена: ${addedCount} новых файлов добавлено`,
      synced: true,
      stats: {
        documents: docCount?.count || 0,
        visible: visibleCount?.count || 0
      }
    });
  } catch (error) {
    console.error('❌ Ошибка синхронизации с FTP:', error.message);
    res.json({
      success: false, 
      message: 'Ошибка синхронизации: ' + error.message,
      synced: false
    });
  }
});

// Удалить подраздел
app.delete('/api/admin/subsections/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Убираем связь с документами
    dbRun("UPDATE documents SET subsection_id = NULL WHERE subsection_id = ?", [id]);
    
    // Удаляем подраздел
    dbRun("DELETE FROM subsections WHERE id = ?", [id]);
    
    console.log(`🗑️ Удален подраздел ID: ${id}`);
    
    // 📦 Сохраняем бэкап на FTP
    await syncDataToFTP();

    res.json({ success: true, message: 'Подраздел удален' });
  } catch (error) {
    console.error('❌ Ошибка удаления подраздела:', error);
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
    
    // 📤 Загружаем изображение на FTP бэкап
    const ftpResult = await uploadToFTP(file.path, file.filename);
    if (ftpResult) {
      console.log(`💾 FTP бэкап изображения создан: ${file.filename}`);
    } else {
      console.warn(`⚠️ FTP бэкап изображения НЕ создан: ${file.filename}`);
    }

    // 📦 Синхронизируем данные на FTP (обновляем JSON)
    await syncDataToFTP();

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

// 📊 Получить ВСЕ данные одним запросом (для фронтенда)
app.get('/api/alldata', async (req, res) => {
  try {
    const data = createSiteDataJSON();
    res.json(data);
  } catch (error) {
    console.error('❌ Ошибка получения всех данных:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить все блоки (публичный доступ)
app.get('/api/blocks', async (req, res) => {
  try {
    const blocks = dbAll("SELECT id, name, title, subtitle, content, button_text, button_link, image, items, is_visible, updated_at, map_address FROM blocks WHERE is_visible = 1");
    const blocksData = blocks.map(block => {
      const parsedItems = block.items ? JSON.parse(block.items) : null;
      return {
        ...block,
        items: parsedItems,
        is_visible: Boolean(block.is_visible),
        map_address: block.map_address || ''
      };
    });
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
    const block = dbGet("SELECT id, name, title, subtitle, content, button_text, button_link, image, items, is_visible, updated_at, map_address FROM blocks WHERE name = ? AND is_visible = 1", [name]);
    if (!block) {
      return res.status(404).json({ error: 'Блок не найден' });
    }
    const parsedItems = block.items ? JSON.parse(block.items) : null;
    const result = {
      ...block,
      items: parsedItems,
      is_visible: Boolean(block.is_visible),
      map_address: block.map_address || ''
    };
    res.json(result);
  } catch (error) {
    console.error('❌ Ошибка получения блока:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить все блоки для админки
app.get('/api/admin/blocks', authenticateToken, async (req, res) => {
  try {
    const blocks = await dbAll("SELECT id, name, title, subtitle, content, button_text, button_link, image, items, is_visible, updated_at, map_address FROM blocks ORDER BY id");
    const blocksData = blocks.map(block => {
      const parsedItems = block.items ? JSON.parse(block.items) : null;
      return {
        ...block,
        items: parsedItems,
        is_visible: Boolean(block.is_visible),
        map_address: block.map_address || ''
      };
    });
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
    const { title, subtitle, content, button_text, button_link, image, items, is_visible, map_address } = req.body;

    const existingBlock = dbGet("SELECT * FROM blocks WHERE id = ?", [id]);
    if (!existingBlock) {
      return res.status(404).json({ error: 'Блок не найден' });
    }

    // Для всех блоков используем items как есть
    const itemsJson = items ? JSON.stringify(items) : existingBlock.items;

    dbRun(
      `UPDATE blocks 
       SET title = ?, subtitle = ?, content = ?, button_text = ?, button_link = ?, image = ?, items = ?, is_visible = ?, updated_at = CURRENT_TIMESTAMP, map_address = ?
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
        map_address !== undefined ? map_address : (existingBlock.map_address || ''),
        id
      ]
    );

    console.log(`✅ Обновлен блок ID: ${id} (${existingBlock.name})`);
    console.log(`   📝 content: "${content ? content.substring(0, 50) + '...' : '(пусто)'}"`);

    // 📦 Сохраняем бэкап на FTP
    console.log('   📤 Синхронизация с FTP...');
    try {
      await syncDataToFTP();
      console.log('   ✅ Синхронизация с FTP завершена');
    } catch (ftpError) {
      console.error('   ❌ Ошибка синхронизации с FTP:', ftpError.message);
    }

    res.json({ success: true, message: 'Блок обновлен' });
  } catch (error) {
    console.error('❌ Ошибка обновления блока:', error);
    res.status(500).json({ error: 'Ошибка при обновлении' });
  }
});

// 📥 РАБОТА С ФАЙЛАМИ

// 📁 Настраиваем статику для папки uploads (для корректной отдачи бинарных файлов)
app.use('/files', express.static(uploadsDir, {
  dotfiles: 'ignore',
  etag: false,
  extensions: false,
  fallthrough: false,
  immutable: false,
  index: false,
  redirect: false,
  setHeaders: (res, filePath) => {
    // Отключаем любую обработку - отдаём как есть
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Transfer-Encoding', 'binary');
    
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') {
      res.setHeader('Content-Type', 'application/pdf');
    }
  }
}));

// 🔍 ДИАГНОСТИКА: Проверить что отдаёт сервер
app.get('/api/debug/download/:filename', async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(uploadsDir, filename);
  
  try {
    // Проверяем локально
    if (!fs.existsSync(filePath)) {
      // Пробуем с FTP
      await downloadFromFTP(filename, filePath);
    }
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Файл не найден' });
    }
    
    const stat = fs.statSync(filePath);
    const buffer = fs.readFileSync(filePath);
    const header = buffer.slice(0, 20).toString('hex');
    
    res.json({ 
      filename,
      exists: true,
      size: stat.size,
      headerHex: header,
      headerAscii: buffer.slice(0, 10).toString('ascii').substring(0, 5),
      isPdf: filename.toLowerCase().endsWith('.pdf'),
      isPdfHeader: buffer.slice(0, 5).toString('ascii').startsWith('%PDF')
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔍 АЛЬТЕРНАТИВНЫЙ МАРШРУТ: Отдача через base64 (обходит проблемы с бинарной передачей)
app.get('/api/download-b64/:filename', async (req, res) => {
  const filename = req.params.filename;
  const mode = req.query.mode || 'download';
  const originalName = req.query.original || filename;
  const filePath = path.join(uploadsDir, filename);
  
  try {
    console.log(`📥 [base64] Скачивание файла: ${filename}`);
    
    if (!fs.existsSync(filePath)) {
      const downloaded = await downloadFromFTP(filename, filePath);
      if (!downloaded) {
        return res.status(404).json({ error: 'Файл не найден' });
      }
    }
    
    // Читаем файл и кодируем в base64
    const fileBuffer = fs.readFileSync(filePath);
    const base64 = fileBuffer.toString('base64');
    
    const headerBytes = fileBuffer.slice(0, 10);
    const headerStr = headerBytes.toString('ascii').substring(0, 5);
    console.log(`   🔍 Заголовок: "${headerStr}"`);
    
    const mimeType = getMimeType(filename);
    
    // Отдаём base64 + метаданные
    res.json({ 
      filename: originalName,
      mimeType,
      size: fileBuffer.length,
      data: base64  // Клиент декодирует и создаёт Blob
    });
    
    console.log(`   ✅ Отправлено (base64, ${base64.length} символов)`);
    
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 🔍 НОВЫЙ МАРШРУТ: Отдача напрямую из буфера (минуя стримы)
app.get('/api/download-dataurl/:filename', async (req, res) => {
  const filename = req.params.filename;
  const originalName = req.query.original || filename;
  const filePath = path.join(uploadsDir, filename);
  
  try {
    console.log(`📥 [buffer] Скачивание файла: ${filename}`);
    
    // Скачиваем напрямую в буфер (не на диск!)
    let fileBuffer = await downloadFileToBuffer(filename);
    
    if (!fileBuffer) {
      // Fallback: читаем с диска
      if (!fs.existsSync(filePath)) {
        const downloaded = await downloadFromFTP(filename, filePath);
        if (!downloaded) {
          return res.status(404).json({ error: 'Файл не найден' });
        }
      }
      fileBuffer = fs.readFileSync(filePath);
    }
    
    console.log(`   📄 Размер буфера: ${fileBuffer.length} bytes`);
    
    // Проверяем заголовок
    const headerStr = fileBuffer.slice(0, 5).toString('ascii');
    console.log(`   🔍 Заголовок: "${headerStr}"`);
    
    const mimeType = getMimeType(filename);
    
    // Заголовки для бинарного файла
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', fileBuffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(originalName)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // Отдаём буфер напрямую
    res.end(fileBuffer);
    
    console.log(`   ✅ Отправлено ${fileBuffer.length} байт`);
    
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
});

// 🔐 FIXED: Скачивание/предпросмотр файла (публичный доступ)
// ?mode=preview - для предпросмотра в браузере (inline)
// ?mode=download или без параметра - для скачивания (attachment)
// ?direct=1 - читать напрямую с FTP без записи на диск
// Используем pipe через fs для надёжной передачи
app.get('/api/download/:filename', async (req, res) => {
  const filename = req.params.filename;
  const mode = req.query.mode || 'download';
  const direct = req.query.direct === '1';
  const originalName = req.query.original || filename;
  const filePath = path.join(uploadsDir, filename);
  
  try {
    console.log(`📥 Скачивание файла: ${filename} (mode: ${mode}, direct: ${direct})`);
    
    let fileBuffer;
    
    if (direct) {
      // 📥 Читаем файл напрямую с FTP в буфер (без записи на диск)
      console.log(`   📥 Читаем напрямую с FTP...`);
      fileBuffer = await downloadFileToBuffer(filename);
      if (!fileBuffer) {
        console.log(`❌ Файл не найден на FTP: ${filename}`);
        return res.status(404).json({ error: 'Файл не найден' });
      }
      console.log(`   ✅ Скачано с FTP: ${fileBuffer.length} bytes`);
    } else {
      // Пробуем скачать с FTP если нет локально
      if (!fs.existsSync(filePath)) {
        console.log(`   📥 Файла нет локально, пробуем с FTP...`);
        const downloaded = await downloadFromFTP(filename, filePath);
        if (!downloaded) {
          console.log(`❌ Файл не найден: ${filename}`);
          return res.status(404).json({ error: 'Файл не найден' });
        }
      } else {
        console.log(`   📄 Файл найден локально: ${filename}`);
      }
      
      // Читаем файл
      fileBuffer = fs.readFileSync(filePath);
      console.log(`   📄 Размер файла: ${fileBuffer.length} bytes`);
    }
    
    // 🔍 ДЕБАГ: Проверяем заголовок файла перед отдачей
    const headerBytes = fileBuffer.slice(0, 10);
    const headerStr = headerBytes.toString('ascii').substring(0, 5);
    console.log(`   🔍 Заголовок: "${headerStr}" (hex: ${headerBytes.toString('hex').substring(0, 20)})`);
    
    if (filename.toLowerCase().endsWith('.pdf')) {
      if (!headerStr.startsWith('%PDF')) {
        console.error(`   ❌ PDF поврежден!`);
        return res.status(500).json({ error: 'Файл повреждён' });
      }
      console.log(`   ✅ PDF заголовок OK`);
    }
    
    const mimeType = getMimeType(filename);
    
    // Очищаем все предыдущие заголовки
    res.removeHeader('Content-Encoding');
    res.removeHeader('Transfer-Encoding');
    
    // Устанавливаем заголовки
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', fileBuffer.length);
    res.setHeader('Content-Disposition', mode === 'preview' 
      ? `inline; filename="${encodeURIComponent(originalName)}"` 
      : `attachment; filename="${encodeURIComponent(originalName)}"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    console.log(`   📤 Отдаем файл через pipe (${fileBuffer.length} bytes)`);
    
    // Создаём ReadStream и пишем напрямую в response
    const readStream = fs.createReadStream(filePath);
    
    readStream.on('error', (err) => {
      console.error(`   ❌ Ошибка стрима: ${err.message}`);
      if (!res.writableEnded) {
        res.destroy();
      }
    });
    
    readStream.pipe(res);
    
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Ошибка сервера' });
    }
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

// 🔄 МИГРАЦИЯ: Перенос legal_info из items в content для documents
app.post('/api/admin/migrate-legal-info', authenticateToken, async (req, res) => {
  try {
    console.log('🔄 Миграция legal_info → content...');
    
    const documentsBlock = dbGet("SELECT * FROM blocks WHERE name = 'documents'");
    
    if (!documentsBlock) {
      return res.status(404).json({ error: 'Блок documents не найден' });
    }
    
    // Парсим items
    let items = {};
    try {
      items = documentsBlock.items ? JSON.parse(documentsBlock.items) : {};
    } catch (e) {
      items = {};
    }
    
    // Если есть legal_info в items и content пустой - переносим
    if (items.legal_info && !documentsBlock.content) {
      dbRun(
        "UPDATE blocks SET content = ?, items = NULL WHERE name = 'documents'",
        [items.legal_info]
      );
      
      console.log(`✅ Миграция завершена: legal_info перенесен в content`);
      console.log(`   Текст: "${items.legal_info.substring(0, 50)}..."`);
      
      await syncDataToFTP();
      
      res.json({ 
        success: true, 
        message: 'Миграция завершена',
        migrated: true,
        content: items.legal_info
      });
    } else if (documentsBlock.content) {
      res.json({ 
        success: true, 
        message: 'Content уже заполнен, миграция не требуется',
        migrated: false,
        content: documentsBlock.content
      });
    } else {
      res.json({ 
        success: true, 
        message: 'Legal_info не найден в items',
        migrated: false
      });
    }
  } catch (error) {
    console.error('❌ Ошибка миграции:', error);
    res.status(500).json({ error: 'Ошибка миграции' });
  }
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
    
    const mimeType = getMimeType(filename);
    // Читаем файл напрямую в буфер (бинарный режим)
    const fileBuffer = fs.readFileSync(filePath);
    
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', fileBuffer.length);
    // Используем end() для гарантии бинарной целостности
    res.end(fileBuffer);
  } catch (error) {
    console.error('❌ Ошибка статики:', error);
    if (!res.headersSent) {
      res.status(500).send('Ошибка сервера');
    }
  }
});

// 🔄 Синхронизация файлов с FTP (добавляет новые, не удаляя существующие)
async function syncFilesFromFTP() {
  console.log('🔄 Синхронизация файлов с FTP...');
  
  const client = new FTPClient();
  
  try {
    await client.connect(FTP_CONFIG.host, FTP_CONFIG.port);
    await client.login(FTP_CONFIG.user, FTP_CONFIG.password);
    
    await client.cd(FTP_CONFIG.remotePath);
    const fileList = await client.list();
    console.log(`📂 Всего файлов на FTP: ${fileList.length}`);
    console.log(`   📄 Список: ${fileList.map(f => f.name).join(', ')}`);
    
    // Пропускаем служебные файлы
    const actualFiles = fileList.filter(f => 
      f.name !== 'named' && 
      !f.name.startsWith('.') &&
      !f.name.endsWith('.json') &&
      !f.name.endsWith('.sqlite')
    );
    console.log(`   📂 Файлов для синхронизации (без .json и .sqlite): ${actualFiles.length}`);
    
    if (actualFiles.length === 0) {
      console.log('   📂 Нет файлов для синхронизации');
      return 0;
    }
   
    let addedCount = 0;
    
    for (const file of actualFiles) {
      const localPath = path.join(uploadsDir, file.name);
      
      // Проверяем, есть ли уже такой файл локально
      if (!fs.existsSync(localPath)) {
        console.log(`   📥 Скачиваем: ${file.name} (${file.size} bytes)`);
        
        try {
          await client.downloadTo(localPath, file.name);
          
          // Проверяем что файл скачался корректно
          const stat = fs.statSync(localPath);
          if (stat.size === file.size) {
            console.log(`   ✅ Скачан: ${file.name}`);
            
            // Добавляем в базу данных если нет
            const existingDoc = dbGet("SELECT * FROM documents WHERE filename = ?", [file.name]);
            if (!existingDoc) {
              const ext = path.extname(file.name).toLowerCase().replace('.', '');
              dbRun(
                "INSERT INTO documents (title, filename, original_name, file_size, file_type, is_visible) VALUES (?, ?, ?, ?, ?, 1)",
                [file.name.replace(/\.[^/.]+$/, ''), file.name, file.name, file.size, ext]
              );
              addedCount++;
            }
          } else {
            console.log(`   ⚠️ Размер не совпал: ${file.name}`);
            if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
          }
        } catch (downloadErr) {
          console.error(`   ❌ Ошибка скачивания ${file.name}:`, downloadErr.message);
        }
      } else {
        console.log(`   ⏭️ Уже есть: ${file.name}`);
      }
    }
    
    if (addedCount > 0) {
      saveDatabase();
    }
    
    console.log(`✅ Синхронизация завершена: ${addedCount} новых файлов`);
    return addedCount;
    
  } catch (error) {
    console.error('❌ Ошибка синхронизации:', error.message);
    return 0;
  } finally {
    try {
      await client.close();
    } catch {}
  }
}

// Запуск сервера
async function startServer() {
  // Инициализируем базу данных
  await initDatabase();
  
  // Загружаем базу данных с FTP если доступна
  await loadDatabaseFromFTP();
  
  // Загружаем бэкап если есть
  await loadBackupFromFTP();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📍 API: http://localhost:${PORT}/api`);
    console.log(`📁 Загрузки: http://localhost:${PORT}/uploads`);
  });
}

startServer().catch(console.error);
   