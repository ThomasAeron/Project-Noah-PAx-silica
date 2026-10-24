import { query } from '../db.js';
import { verifyToken } from '../auth.js';

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { rows } = await query(
    `select u.id, u.email, u.full_name, u.is_active, r.name as role_name
     from users u
     left join roles r on r.id = u.role_id
     where u.id = $1`,
    [payload.sub]
  );

  if (rows.length === 0 || !rows[0].is_active) {
    return res.status(401).json({ error: 'Account not found or inactive' });
  }

  req.user = {
    id: rows[0].id,
    email: rows[0].email,
    full_name: rows[0].full_name,
    roles: rows[0].role_name ? [rows[0].role_name] : [],
  };
  next();
}

export function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const ok = allowed.some((role) => req.user.roles.includes(role));
    if (!ok) {
      return res.status(403).json({
        error: `Requires one of: ${allowed.join(', ')}`,
      });
    }
    next();
  };
}