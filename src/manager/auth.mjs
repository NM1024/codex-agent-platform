import {randomBytes,createHash,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {HttpError} from '../errors.mjs';
const derive=promisify(scrypt),digest=value=>createHash('sha256').update(value).digest('hex');
const unauthorized=()=>new HttpError(401,'UNAUTHORIZED','密码不正确或登录已过期。');
const currentPasswordInvalid=()=>new HttpError(403,'CURRENT_PASSWORD_INVALID','当前密码不正确。');
export class AdminAuth {
  constructor(db) {
    this.db=db;this.sessionTtlMs=43200000;
    db.exec(`CREATE TABLE IF NOT EXISTS manager_auth(id INTEGER PRIMARY KEY CHECK(id=1),salt BLOB NOT NULL,hash BLOB NOT NULL,version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_sessions(token_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);`);
  }
  get initialized(){return !!this.db.prepare('SELECT 1 FROM manager_auth WHERE id=1').get();}
  validate(password){if(typeof password!=='string'||password.length<12||password.length>1024||!password.trim())throw new HttpError(400,'INVALID_PASSWORD','密码须为12至1024个字符。');}
  async initialize(password) {
    if(this.initialized)return;
    this.validate(password);const salt=randomBytes(16),hash=await derive(password,salt,64);
    this.db.prepare('INSERT OR IGNORE INTO manager_auth VALUES(1,?,?,0)').run(salt,hash);
  }
  async login(password) {
    if(typeof password!=='string'||password.length>1024)throw unauthorized();
    const record=this.db.prepare('SELECT salt,hash,version FROM manager_auth WHERE id=1').get();if(!record)throw unauthorized();
    const hash=await derive(password,record.salt,64);if(!timingSafeEqual(hash,Buffer.from(record.hash)))throw unauthorized();
    const token=randomBytes(32).toString('base64url'),expires_at=Date.now()+this.sessionTtlMs;
    this.db.prepare('DELETE FROM manager_sessions WHERE expires_at<=?').run(Date.now());
    // A concurrent password change must also invalidate a login already hashing.
    const inserted=this.db.prepare('INSERT INTO manager_sessions SELECT ?,? FROM manager_auth WHERE id=1 AND version=?').run(digest(token),expires_at,record.version);
    if(!inserted.changes)throw unauthorized();return {token,expires_at};
  }
  token(req) {
    const values=(req.headers.cookie ?? '').split(';').map(value=>value.trim()).filter(value=>value.startsWith('agent_admin='));
    if(values.length!==1)return null;const token=values[0].slice('agent_admin='.length);return /^[\w-]{43}$/.test(token)?token:null;
  }
  authorize(req,now=Date.now()) {const token=this.token(req);return !!(token&&this.db.prepare('SELECT 1 FROM manager_sessions WHERE token_hash=? AND expires_at>?').get(digest(token),now));}
  logout(req){const token=this.token(req);if(token)this.db.prepare('DELETE FROM manager_sessions WHERE token_hash=?').run(digest(token));}
  cookie(token,req,expiresAt=0) {
    const secure=req.socket?.encrypted||req.headers['x-forwarded-proto']==='https';
    return `agent_admin=${token}; Path=/admin/; HttpOnly; SameSite=Strict; Max-Age=${token?Math.max(0,Math.floor((expiresAt-Date.now())/1000)):0}${secure?'; Secure':''}`;
  }
  async setPassword(password) {
    this.validate(password);const salt=randomBytes(16),hash=await derive(password,salt,64);
    this.db.exec('SAVEPOINT admin_password');
    try {this.db.prepare('UPDATE manager_auth SET salt=?,hash=?,version=version+1 WHERE id=1').run(salt,hash);this.db.exec('DELETE FROM manager_sessions; RELEASE admin_password');}
    catch(error){this.db.exec('ROLLBACK TO admin_password; RELEASE admin_password');throw error;}
  }
  async changePassword(currentPassword,password) {
    if(typeof currentPassword!=='string'||currentPassword.length>1024)throw currentPasswordInvalid();
    const record=this.db.prepare('SELECT salt,hash,version FROM manager_auth WHERE id=1').get();if(!record)throw currentPasswordInvalid();
    const currentHash=await derive(currentPassword,record.salt,64);
    if(!timingSafeEqual(currentHash,Buffer.from(record.hash)))throw currentPasswordInvalid();
    this.validate(password);const salt=randomBytes(16),hash=await derive(password,salt,64);
    this.db.exec('SAVEPOINT admin_password');
    try {
      // The password verified above must still be current after asynchronous hashing.
      const updated=this.db.prepare('UPDATE manager_auth SET salt=?,hash=?,version=version+1 WHERE id=1 AND version=?').run(salt,hash,record.version);
      if(!updated.changes)throw currentPasswordInvalid();
      this.db.exec('DELETE FROM manager_sessions; RELEASE admin_password');
    }catch(error){this.db.exec('ROLLBACK TO admin_password; RELEASE admin_password');throw error;}
  }
}
