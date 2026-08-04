const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Использование: npm run hash-password -- "мойпароль"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log('\nВставьте это значение в .env как ADMIN_PASSWORD_HASH:\n');
console.log(hash);
console.log('');
