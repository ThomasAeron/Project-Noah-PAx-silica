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
    `select u.id, u.email, u.full_name, u.is_active,
            coalesce(array_agg(r.name) filter (where r.name is not null), '{}') as roles
     from users u
     left join user_roles ur on ur.user_id = u.id
     left join roles r on r.id = ur.role_id
     where u.id = $1
     group by u.id`,
    [payload.sub]
  );

  if (rows.length === 0 || !rows[0].is_active) {
    return res.status(401).json({ error: 'Account not found or inactive' });
  }

  req.user = {
    id: rows[0].id,
    email: rows[0].email,
    full_name: rows[0].full_name,
    roles: rows[0].roles,
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