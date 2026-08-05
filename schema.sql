-- ============================================================================
-- FARMACORP · INVENTARIO PRO — SCHEMA SUPABASE
-- CEDIS Santa Cruz · Almacenes B100 / A102
-- Todas las tablas/funciones llevan el prefijo `inv_` a propósito, para
-- convivir sin choques dentro del mismo proyecto de Supabase que usas para
-- Portal COMEX & Logística (que ya tiene sus propias tablas `usuarios`,
-- `productos`, etc.). Ejecutar completo en el SQL Editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. EXTENSIÓN NECESARIA PARA HASH DE CONTRASEÑAS (puede que ya exista si
-- Portal COMEX u otro proyecto ya la activó; el IF NOT EXISTS lo hace seguro)
-- ----------------------------------------------------------------------------
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. TABLA: inv_usuarios
-- Operadores no necesitan contraseña (ingreso rápido por nombre + turno).
-- Supervisores/Auditores sí requieren contraseña (guardada con hash bcrypt).
-- ----------------------------------------------------------------------------
create table if not exists inv_usuarios (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  password_hash text,                      -- null para operadores
  nombre_completo text,
  role text not null check (role in ('operador','supervisor')),
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. TABLA: inv_productos_maestro
-- Un producto = una fila. Columnas alineadas a tu export real de WMS
-- (Nro LPN / Cod Alternat / Producto / Descripción / cantidades / ubicación /
-- lote / vencimiento / etc.). `almacen` queda como texto libre porque tus
-- códigos de ubicación real (ej. CU-CT-ME-...) no siempre calzan en un
-- enum fijo tipo B100/A102 — filtra por prefijo si necesitas agrupar.
-- ----------------------------------------------------------------------------
create table if not exists inv_productos_maestro (
  id uuid primary key default gen_random_uuid(),

  -- identificación
  cod_alternato text unique,                 -- "Cod Alternat" — normalmente el código de fábrica/EAN actual
  producto_codigo text,                      -- columna "Producto" del WMS (SKU interno, puede incluir categoría)
  descripcion text not null,                 -- columna "Descripción"
  nro_lpn_actual text,                       -- último LPN visto para este producto (referencia, no único)

  -- cantidades (snapshot del WMS al momento de importar)
  cantidad_recibida integer default 0,
  cantidad_actual integer default 0,         -- <- este es el "stock teórico" que usa la app para comparar
  cantidad_asignada integer default 0,
  cantidad_paquete integer default 1,
  numero_bloqueos integer default 0,

  -- ubicación
  almacen text,                              -- ej. Sucursal Dest, o prefijo de ubicación
  ubicacion text,                            -- "Ubicación" actual
  ubicacion_anterior text,

  -- lote / vencimiento
  nro_lote text,
  fecha_caducidad date,

  -- trazabilidad WMS (referencia, no la edita la app)
  nro_oc text,
  envio_recibido text,
  nro_pallet text,
  lpn_es_paleta boolean,
  sucursal_dest text,
  fecha_creacion_wms timestamptz,
  usuario_creado_wms text,
  fecha_modif_wms timestamptz,
  usuario_modifico_wms text,

  -- control interno de la app
  creado_manual boolean not null default false,  -- true = lo creó un operador al escanear algo no encontrado
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_inv_productos_cod_alternato on inv_productos_maestro (cod_alternato);
create index if not exists idx_inv_productos_lpn on inv_productos_maestro (nro_lpn_actual);
create index if not exists idx_inv_productos_descripcion on inv_productos_maestro using gin (to_tsvector('spanish', descripcion));

-- ----------------------------------------------------------------------------
-- 2b. TABLA: inv_producto_codigos
-- Resuelve el problema de "a veces es el código antiguo, a veces el nuevo":
-- un producto puede tener VARIOS códigos válidos (Cod Alternat histórico,
-- distintos Nro LPN que ha llevado, códigos de barras alternativos). Cada
-- fila aquí es "este texto escaneado -> este producto".
-- ----------------------------------------------------------------------------
create table if not exists inv_producto_codigos (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid not null references inv_productos_maestro(id) on delete cascade,
  codigo text not null unique,
  tipo text not null check (tipo in ('COD_ALTERNO','LPN','EAN_HISTORICO','OTRO')),
  created_at timestamptz not null default now()
);

create index if not exists idx_inv_codigos_producto on inv_producto_codigos (producto_id);

-- ----------------------------------------------------------------------------
-- 3. TABLA: inv_conteos_inventario
-- Diferenciación clave del negocio:
--   cantidad_danada  -> MERMA REAL / pérdida física (roto, manchado, mojado, etc.)
--   cantidad_cruzada -> PRODUCTO CRUZADO / recuperable (variante o SKU incorrecto
--                       dentro de la caja, pero el ítem en sí está SANO y se
--                       puede reetiquetar o reubicar; NO es pérdida).
--   cantidad_buena   -> se calcula sola (total - dañada - cruzada)
-- ----------------------------------------------------------------------------
create table if not exists inv_conteos_inventario (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid not null references inv_productos_maestro(id),
  usuario_id uuid references inv_usuarios(id) on delete set null,  -- borrar un usuario NO borra su historial
  usuario_nombre text not null,             -- desnormalizado para lecturas rápidas (por eso el conteo sigue legible aunque borres al usuario)
  almacen text not null,
  zona text,
  cantidad_total integer not null default 0 check (cantidad_total >= 0),
  cantidad_danada integer not null default 0 check (cantidad_danada >= 0),
  cantidad_cruzada integer not null default 0 check (cantidad_cruzada >= 0),
  cantidad_buena integer generated always as
    (cantidad_total - cantidad_danada - cantidad_cruzada) stored,
  cantidad_teorica_snapshot integer,
  es_vencido boolean not null default false,
  fecha_vencimiento date,
  tipos_incidencia text[] not null default '{}',   -- ej. {DANO,CRUZADO,VENCIDO,FALTANTE}
  descripcion_dano text,                            -- texto libre: "empaque roto", "manchado"...
  foto_evidencia_url text,                          -- URL de Cloudinary de la foto del producto/daño
  lote text,                                        -- número de lote (si aplica, ligado a vencimiento)
  ubicacion text,                                   -- pasillo/rack exacto dentro del almacén
  observaciones text,
  created_at timestamptz not null default now(),
  constraint chk_inv_suma_no_excede_total
    check (cantidad_danada + cantidad_cruzada <= cantidad_total)
);

create index if not exists idx_inv_conteos_producto on inv_conteos_inventario (producto_id);
create index if not exists idx_inv_conteos_usuario on inv_conteos_inventario (usuario_nombre);
create index if not exists idx_inv_conteos_created on inv_conteos_inventario (created_at desc);

-- ----------------------------------------------------------------------------
-- 3b. MIGRACIÓN — ejecuta esto SOLO si ya habías corrido una versión anterior
-- de este schema (es decir, inv_conteos_inventario ya existe sin las columnas
-- nuevas). Si es tu primera vez ejecutando el script completo en este
-- proyecto, puedes ignorar este bloque: el CREATE TABLE de arriba ya las incluye.
-- ----------------------------------------------------------------------------
alter table inv_conteos_inventario add column if not exists tipos_incidencia text[] not null default '{}';
alter table inv_conteos_inventario add column if not exists descripcion_dano text;
alter table inv_conteos_inventario add column if not exists foto_evidencia_url text;
alter table inv_conteos_inventario add column if not exists lote text;
alter table inv_conteos_inventario add column if not exists ubicacion text;

-- Si ya habías corrido el schema antes de este cambio, arregla la FK para
-- que borrar un usuario en inv_usuarios no falle por su historial de conteos:
alter table inv_conteos_inventario drop constraint if exists inv_conteos_inventario_usuario_id_fkey;
alter table inv_conteos_inventario
  add constraint inv_conteos_inventario_usuario_id_fkey
  foreign key (usuario_id) references inv_usuarios(id) on delete set null;

-- ----------------------------------------------------------------------------
-- 3c. TABLA: inv_cuarentena
-- Tu "tabla 1": productos actualmente retenidos/bloqueados. Vive separada
-- del stock porque tiene su propio ciclo (ingresa, se libera o se descarta).
-- ----------------------------------------------------------------------------
create table if not exists inv_cuarentena (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid references inv_productos_maestro(id),
  cod_alternato text,
  descripcion text,
  nro_lote text,
  sucursal_dest text,                       -- CT-01 / CT-02 / SLTDP / etc. — para filtrar igual que en Matriz
  cantidad_cuarentena integer not null default 0,
  motivo text,
  estado text not null default 'ACTIVA' check (estado in ('ACTIVA','LIBERADA','DESCARTADA')),
  fecha_ingreso timestamptz not null default now(),
  fecha_liberacion timestamptz,
  usuario_registro text,
  observaciones text,
  created_at timestamptz not null default now()
);

create index if not exists idx_inv_cuarentena_producto on inv_cuarentena (producto_id);
create index if not exists idx_inv_cuarentena_estado on inv_cuarentena (estado);
create index if not exists idx_inv_cuarentena_sucursal on inv_cuarentena (sucursal_dest);

-- Migración: si ya habías corrido esta tabla antes de agregar sucursal_dest
alter table inv_cuarentena add column if not exists sucursal_dest text;

-- ----------------------------------------------------------------------------
-- 3d. TABLA: inv_catalogo_productos
-- Tu "tabla 3": TODOS los productos que existen en el almacén, tengan o no
-- stock ahora mismo (a diferencia de inv_productos_maestro, que es la foto
-- del stock actual). Sirve como diccionario de referencia — por ejemplo
-- para saber si un código escaneado corresponde a un producto Farmacorp
-- aunque hoy no tenga existencias.
-- ----------------------------------------------------------------------------
create table if not exists inv_catalogo_productos (
  id uuid primary key default gen_random_uuid(),
  cod_alternato text unique not null,
  producto_codigo text,
  descripcion text not null,
  categoria text,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_inv_catalogo_cod_alternato on inv_catalogo_productos (cod_alternato);

-- ----------------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY
-- La app usa la anon key (no Supabase Auth) con login propio contra
-- `inv_usuarios`, así que esa tabla NUNCA se expone directo por RLS: solo se
-- accede a través de la función `inv_verificar_login` (SECURITY DEFINER).
-- ----------------------------------------------------------------------------
alter table inv_usuarios enable row level security;
alter table inv_productos_maestro enable row level security;
alter table inv_producto_codigos enable row level security;
alter table inv_conteos_inventario enable row level security;

-- inv_usuarios: sin políticas de SELECT/INSERT/UPDATE/DELETE para anon -> tabla cerrada
-- (deliberado: cero acceso directo, todo pasa por la función de login)

-- inv_productos_maestro: lectura abierta (catálogo) + inserción abierta.
-- La inserción SÍ está abierta a propósito: cuando un operador escanea un
-- código que no existe, la app le permite crear el producto ahí mismo
-- (queda marcado con creado_manual = true para que lo revises después).
drop policy if exists "inv_productos_select_anon" on inv_productos_maestro;
create policy "inv_productos_select_anon"
  on inv_productos_maestro for select
  to anon
  using (true);

drop policy if exists "inv_productos_insert_anon" on inv_productos_maestro;
create policy "inv_productos_insert_anon"
  on inv_productos_maestro for insert
  to anon
  with check (true);

-- inv_producto_codigos: lectura + inserción abiertas (para registrar un
-- código nuevo/alterno que apunte a un producto ya existente)
drop policy if exists "inv_codigos_select_anon" on inv_producto_codigos;
create policy "inv_codigos_select_anon"
  on inv_producto_codigos for select
  to anon
  using (true);

drop policy if exists "inv_codigos_insert_anon" on inv_producto_codigos;
create policy "inv_codigos_insert_anon"
  on inv_producto_codigos for insert
  to anon
  with check (true);

-- inv_conteos_inventario: lectura abierta (dashboard/control) + inserción abierta (registro de conteo)
drop policy if exists "inv_conteos_select_anon" on inv_conteos_inventario;
create policy "inv_conteos_select_anon"
  on inv_conteos_inventario for select
  to anon
  using (true);

drop policy if exists "inv_conteos_insert_anon" on inv_conteos_inventario;
create policy "inv_conteos_insert_anon"
  on inv_conteos_inventario for insert
  to anon
  with check (true);

-- inv_cuarentena: lectura + inserción abiertas (registrar y ver retenciones)
alter table inv_cuarentena enable row level security;
drop policy if exists "inv_cuarentena_select_anon" on inv_cuarentena;
create policy "inv_cuarentena_select_anon"
  on inv_cuarentena for select
  to anon
  using (true);

drop policy if exists "inv_cuarentena_insert_anon" on inv_cuarentena;
create policy "inv_cuarentena_insert_anon"
  on inv_cuarentena for insert
  to anon
  with check (true);

-- inv_catalogo_productos: lectura + inserción abiertas (diccionario de referencia)
alter table inv_catalogo_productos enable row level security;
drop policy if exists "inv_catalogo_select_anon" on inv_catalogo_productos;
create policy "inv_catalogo_select_anon"
  on inv_catalogo_productos for select
  to anon
  using (true);

drop policy if exists "inv_catalogo_insert_anon" on inv_catalogo_productos;
create policy "inv_catalogo_insert_anon"
  on inv_catalogo_productos for insert
  to anon
  with check (true);

-- Nota: si en el futuro un supervisor necesita editar/eliminar un conteo o
-- un producto, crea una función RPC SECURITY DEFINER específica (igual que
-- el login), en vez de abrir UPDATE/DELETE directo por RLS.

-- ----------------------------------------------------------------------------
-- 5. FUNCIÓN DE LOGIN SEGURO (bypassa RLS de inv_usuarios vía SECURITY DEFINER)
-- Nombre prefijado (inv_verificar_login) para no chocar con una función
-- `verificar_login` que ya pudieras tener en otro proyecto/schema.
-- Operador  -> valido = true con solo el username (ingreso rápido).
-- Supervisor -> valido = true solo si la contraseña coincide con el hash.
-- ----------------------------------------------------------------------------
create or replace function public.inv_verificar_login(p_username text, p_password text default null)
returns table (
  id uuid,
  username text,
  nombre_completo text,
  role text,
  valido boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    u.id,
    u.username,
    u.nombre_completo,
    u.role,
    case
      when u.role = 'operador' then true
      when u.role = 'supervisor'
           and u.password_hash is not null
           and p_password is not null
           and crypt(p_password, u.password_hash) = u.password_hash
        then true
      else false
    end as valido
  from inv_usuarios u
  where u.username = p_username
    and u.activo = true;
end;
$$;

revoke all on function public.inv_verificar_login(text, text) from public;
grant execute on function public.inv_verificar_login(text, text) to anon;

-- ----------------------------------------------------------------------------
-- 6. TRIGGER: mantener updated_at de inv_productos_maestro
-- ----------------------------------------------------------------------------
create or replace function public.inv_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_inv_productos_updated_at on inv_productos_maestro;
create trigger trg_inv_productos_updated_at
  before update on inv_productos_maestro
  for each row execute function public.inv_set_updated_at();

-- ----------------------------------------------------------------------------
-- 6b. Columna adicional en inv_conteos_inventario: "observado_por" — otras
-- personas que acompañaron/validaron el conteo (columna "AC" de tu Excel:
-- nombres, no cantidad, a pesar del encabezado "cantidad de productos
-- observados" — la dejamos como texto libre con nombres separados por coma).
-- ----------------------------------------------------------------------------
alter table inv_conteos_inventario add column if not exists observado_por text;

-- ----------------------------------------------------------------------------
-- 7. VISTA: inv_vista_supervisor
-- Esto es lo que pidió tu supervisor: STOCK + CONTEO combinados en una sola
-- fila por producto, con TODAS las columnas relevantes visibles a la vez
-- (no solo un resultado resumido), más el estado de cuarentena y si ya fue
-- contado o sigue PENDIENTE. Con esta vista, "cuántos productos faltan por
-- ingresar" es tan simple como filtrar estado_conteo = 'PENDIENTE'.
-- ----------------------------------------------------------------------------
create or replace view inv_vista_supervisor as
select
  s.id                        as producto_id,
  s.cod_alternato,
  s.producto_codigo,
  s.descripcion,
  s.almacen,
  s.ubicacion,
  s.ubicacion_anterior,
  s.cantidad_recibida,
  s.cantidad_actual           as cantidad_teorica,
  s.cantidad_asignada,
  s.cantidad_paquete,
  s.numero_bloqueos,
  s.nro_lote                  as lote_wms,
  s.fecha_caducidad,
  s.nro_oc,
  s.sucursal_dest,
  s.nro_pallet,
  s.nro_lpn_actual,
  exists (
    select 1 from inv_cuarentena q
    where q.producto_id = s.id and q.estado = 'ACTIVA'
  )                           as en_cuarentena,
  c.id                        as conteo_id,
  c.usuario_nombre            as responsable,
  c.cantidad_total            as cantidad_registrada,
  c.cantidad_danada,
  c.cantidad_cruzada,
  c.tipos_incidencia,
  c.observaciones,
  c.observado_por,
  c.foto_evidencia_url,
  c.created_at                as fecha_conteo,
  case when c.id is null then 'PENDIENTE' else 'CONTADO' end as estado_conteo,
  case when c.id is null then null else (c.cantidad_total - s.cantidad_actual) end as diferencia,
  case
    when c.id is null then null
    when (c.cantidad_total - s.cantidad_actual) > 0 then 'POSITIVO'
    when (c.cantidad_total - s.cantidad_actual) < 0 then 'NEGATIVO'
    else 'NEUTRO'
  end as diferencia_tipo
from inv_productos_maestro s
left join lateral (
  select *
  from inv_conteos_inventario ci
  where ci.producto_id = s.id
  order by ci.created_at desc
  limit 1
) c on true;

grant select on inv_vista_supervisor to anon;

-- ----------------------------------------------------------------------------
-- 7b. FUNCIÓN: inv_buscar_posibles_duplicados
-- El "truco de lógica" que pediste: antes de crear un producto nuevo (porque
-- no matcheó ningún código), busca si algo similar YA existe en las 3 tablas
-- (Stock, Catálogo, Cuarentena) por código exacto o descripción parecida.
-- Evita duplicar el mismo producto físico bajo identidades distintas.
-- ----------------------------------------------------------------------------
create or replace function public.inv_buscar_posibles_duplicados(p_codigo text default null, p_descripcion text default null)
returns table (
  fuente text,           -- 'STOCK' | 'CATALOGO' | 'CUARENTENA'
  id uuid,
  cod_alternato text,
  descripcion text,
  sucursal_dest text,
  estado text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select 'STOCK'::text, s.id, s.cod_alternato, s.descripcion, s.sucursal_dest, null::text
  from inv_productos_maestro s
  where (p_codigo is not null and s.cod_alternato = p_codigo)
     or (p_descripcion is not null and length(p_descripcion) > 3 and s.descripcion ilike '%' || p_descripcion || '%')

  union all

  select 'CATALOGO'::text, c.id, c.cod_alternato, c.descripcion, null::text,
         case when c.activo then 'ACTIVO' else 'INACTIVO' end
  from inv_catalogo_productos c
  where (p_codigo is not null and c.cod_alternato = p_codigo)
     or (p_descripcion is not null and length(p_descripcion) > 3 and c.descripcion ilike '%' || p_descripcion || '%')

  union all

  select 'CUARENTENA'::text, q.id, q.cod_alternato, q.descripcion, q.sucursal_dest, q.estado
  from inv_cuarentena q
  where (p_codigo is not null and q.cod_alternato = p_codigo)
     or (p_descripcion is not null and length(p_descripcion) > 3 and q.descripcion ilike '%' || p_descripcion || '%')

  limit 15;
end;
$$;

grant execute on function public.inv_buscar_posibles_duplicados(text, text) to anon;

-- ----------------------------------------------------------------------------
-- 8. SEEDS DE DEMOSTRACIÓN (borra este bloque cuando cargues tu maestro real)
-- ----------------------------------------------------------------------------
insert into inv_usuarios (username, password_hash, nombre_completo, role) values
  ('jchuarachi', null, 'J. Chuarachi', 'operador'),
  ('mrivero_02', null, 'M. Rivero',    'operador'),
  ('lgutierrez', null, 'L. Gutiérrez', 'operador'),
  ('admin', crypt('admin123', gen_salt('bf')), 'Auditor General', 'supervisor')
on conflict (username) do nothing;

insert into inv_productos_maestro (cod_alternato, producto_codigo, descripcion, almacen, ubicacion, cantidad_actual, cantidad_recibida, nro_lote, fecha_caducidad) values
  ('7791234560012','FC-10231','PARACETAMOL 500MG X 100 TAB','B100','CU-CT-ME-15-00-00',480,480,'L-24081','2027-03-01'),
  ('7791234560029','FC-10455','IBUPROFENO 400MG X 20 TAB','A102','CU-CT-ME-16-00-00',210,210,'L-24102',null),
  ('7791234560036','FC-10877','AMOXICILINA 500MG X 12 CAP','B100','CU-CT-ME-15-01-00',150,150,'L-24077','2026-11-01'),
  ('7791234560043','FC-11002','NUBY DISPENSADOR DE JARABE','A102','CU-CT-ME-17-00-00',96,96,null,null),
  ('7791234560050','FC-11134','VITAMINA C 1G EFERVESCENTE X10','B100','CU-CT-ME-18-00-00',320,320,'L-24055','2026-08-15'),
  ('7791234560067','FC-11290','GUANTES DE LÁTEX TALLA M CAJA X 100','A102','CU-CT-ME-19-00-00',75,75,null,null),
  ('7791234560081','FC-11602','OMEPRAZOL 20MG X 14 CAP','B100','CU-CT-ME-15-02-00',180,180,'L-24063','2027-01-20'),
  ('7791234560104','FC-90001','LECHE FÓRMULA INFANTIL ETAPA 1 800G','A102','CU-CT-ME-20-00-00',64,64,'L-24091','2026-12-05')
on conflict (cod_alternato) do nothing;

-- ============================================================================
-- FIN DEL SCRIPT
-- ============================================================================