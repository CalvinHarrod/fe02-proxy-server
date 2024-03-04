const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const adapter = new FileSync('token-db.json');
const db = low(adapter);

const action = process.argv[2]; // get the action from command line arguments
const id = process.argv[3]; // get the id from command line arguments

if (action === 'purge') {
  // Purge all tokens
  db.set('tokens', []).write();
  console.log('All tokens have been purged.');
} else if (action === 'delete' && id) {
  // Delete a specific token by id
  db.get('tokens').remove({ id }).write();
  console.log(`Token with id ${id} has been deleted.`);
} else {
  console.log('Invalid command. Use "purge" to purge all tokens or "delete [id]" to delete a specific token by id.');
}
