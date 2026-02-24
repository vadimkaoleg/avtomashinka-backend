import bcrypt from 'bcryptjs';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

async function changePassword() {
  const newPassword = process.argv[2];
  const username = process.argv[3] || 'admin';

  if (!newPassword) {
    console.log('❌ Укажите новый пароль: node change-password.js <новый-пароль> [логин]');
    process.exit(1);
  }

  // Хэшируем пароль
  const hash = await bcrypt.hash(newPassword, 10);
  
  // Открываем базу данных
  const db = await open({
    filename: 'database.sqlite',
    driver: sqlite3.Database
  });

  // Проверяем, существует ли пользователь
  const user = await db.get(
    "SELECT * FROM admin_users WHERE username = ?",
    [username]
  );

  if (!user) {
    console.log(`❌ Пользователь "${username}" не найден`);
    await db.close();
    return;
  }

  // Обновляем пароль
  await db.run(
    "UPDATE admin_users SET password_hash = ? WHERE username = ?",
    [hash, username]
  );

  console.log(`✅ Пароль для пользователя "${username}" успешно изменен!`);
  console.log(`🔑 Новые данные для входа:`);
  console.log(`   Логин: ${username}`);
  console.log(`   Пароль: ${newPassword}`);

  await db.close();
}

changePassword().catch(console.error);