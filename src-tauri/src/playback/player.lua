-- Better IPTV: the player's controls, laid out like a streaming service's.
--
-- One hover area: moving the mouse anywhere shows everything (a gradient,
-- a Close ✕ at the top right, the timeline and the buttons at the bottom);
-- it fades after a few seconds of stillness and stays while paused.
--
--                                                                   ✕
--
--   ━━━━━━━━━━━━━━━●───────────────────────────────  42:10
--   ▶  🔊  Series  S2:E5  Episode name                ⏭  ▤  💬  ⚙  ⛶
--
-- Click the picture to pause, double-click for fullscreen. ←/→ jump 10 s,
-- ↑/↓ change the volume. Hovering the timeline previews the frame there
-- once it is downloaded (see Previews). In an episode's last minute a "Next
-- Episode" button shows on its own. Live TV leaves out the timeline.
--
-- Options (script-opts, prefix biptv-player-): series (the series' name, so
-- an episode reads "Series S2:E5 Name"), live (yes for live TV), accent (hex
-- RRGGBB of the progress and highlights; the app's amber by default), mpv (the
-- player program, for the previews) and work (a private folder for them).

local assdraw = require 'mp.assdraw'
local options = require 'mp.options'
local utils = require 'mp.utils'

local opts = { series = '', live = false, accent = 'F2B441', font = 'Noto Sans', mpv = 'mpv', work = '' }
options.read_options(opts, 'biptv-player')

mp.set_property('osc', 'no')
mp.set_property('osd-bar', 'no')

---------------------------------------------------------------------------
-- Colours and drawing
---------------------------------------------------------------------------

-- ASS colours are BGR
local function bgr(hex)
  hex = hex:gsub('#', '')
  return hex:sub(5, 6) .. hex:sub(3, 4) .. hex:sub(1, 2)
end
local ACCENT = bgr(opts.accent)
local WHITE = 'FFFFFF'
local GREY = bgr('B3B3B3')
local TRACK = bgr('5A5A5A')
local BUFFERED = bgr('8C8C8C')
local PANEL = bgr('262626')
-- Text on the accent (the LIVE badge): dark, as on the app's amber buttons
local ON_ACCENT = bgr('111111')

local overlay = mp.create_osd_overlay('ass-events')
local w, h, s = 0, 0, 1 -- osd size and scale (1 at 1080p)

-- One ASS event: position, colour, alpha (00 opaque .. FF clear), then body
local function event(ass, x, y, colour, alpha, body, an)
  ass:new_event()
  ass:append(string.format('{\\an%d\\pos(%.1f,%.1f)\\bord0\\shad0\\1c&H%s&\\1a&H%s&}',
    an or 7, x, y, colour, alpha or '00'))
  ass:append(body)
end

local function rect(ass, x, y, rw, rh, colour, alpha)
  if rw <= 0 or rh <= 0 then return end
  event(ass, 0, 0, colour, alpha,
    string.format('{\\p1}m %d %d l %d %d %d %d %d %d{\\p0}', x, y, x + rw, y, x + rw, y + rh, x, y + rh))
end

local function rounded(ass, x, y, rw, rh, r, colour, alpha)
  ass:new_event()
  ass:append(string.format('{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H%s&\\1a&H%s&}', colour, alpha or '00'))
  ass:draw_start()
  ass:round_rect_cw(x, y, x + rw, y + rh, r)
  ass:draw_stop()
end

local function circle(ass, cx, cy, r, colour, alpha)
  rounded(ass, cx - r, cy - r, 2 * r, 2 * r, r, colour, alpha)
end

local function text(ass, x, y, str, size, colour, an, bold, alpha)
  event(ass, x, y, colour, alpha,
    string.format('{\\fn%s\\fs%d\\b%d\\bord0\\shad0}%s', opts.font, size, bold and 1 or 0,
      str:gsub('\\', '\\\\'):gsub('{', '\\{'):gsub('}', '\\}')), an)
end

-- A vector icon: `path` in a 24×24 box, drawn `size` px wide at x,y (top-left)
local function icon(ass, x, y, size, path, colour, alpha)
  local k = size / 24
  local scaled = path:gsub('(-?[%d%.]+)', function(n) return string.format('%.1f', tonumber(n) * k) end)
  event(ass, x, y, colour, alpha, '{\\p1}' .. scaled .. '{\\p0}')
end

local ICONS = {
  play = 'm 6 3 l 21 12 l 6 21',
  pause = 'm 5 3 l 10 3 l 10 21 l 5 21 m 14 3 l 19 3 l 19 21 l 14 21',
  vol = 'm 2 9 l 7 9 l 13 3 l 13 21 l 7 15 l 2 15',
  wave1 = 'm 15 8 b 17 10 17 14 15 16 l 16 17 b 19 14 19 10 16 7',
  wave2 = 'm 17 5 b 21 9 21 15 17 19 l 18 20 b 23 15 23 9 18 4',
  mute = 'm 16 9 l 17 8 l 23 14 l 22 15 m 22 8 l 23 9 l 17 15 l 16 14',
  next = 'm 3 3 l 16 12 l 3 21 m 18 3 l 21 3 l 21 21 l 18 21',
  episodes = 'm 7 3 l 22 3 l 22 14 l 20 14 l 20 5 l 7 5 m 4 6 l 19 6 l 19 17 l 17 17 l 17 8 l 4 8 m 1 9 l 16 9 l 16 21 l 1 21',
  subs = 'm 1 3 l 23 3 l 23 18 l 19 18 l 19 22 l 15 18 l 1 18',
  -- The bubble's text lines, drawn dark over it
  subs_lines = 'm 4 8 l 10 8 l 10 10 l 4 10 m 12 8 l 20 8 l 20 10 l 12 10 m 4 12 l 14 12 l 14 14 l 4 14 m 16 12 l 20 12 l 20 14 l 16 14',
  full = 'm 1 1 l 9 1 l 9 3 l 3 3 l 3 9 l 1 9 m 15 1 l 23 1 l 23 9 l 21 9 l 21 3 l 15 3 m 1 15 l 3 15 l 3 21 l 9 21 l 9 23 l 1 23 m 21 15 l 23 15 l 23 23 l 15 23 l 15 21 l 21 21',
  unfull = 'm 7 1 l 9 1 l 9 9 l 1 9 l 1 7 l 7 7 m 15 1 l 17 1 l 17 7 l 23 7 l 23 9 l 15 9 m 1 15 l 9 15 l 9 23 l 7 23 l 7 17 l 1 17 m 15 15 l 23 15 l 23 17 l 17 17 l 17 23 l 15 23',
  -- Two crossed bars
  close = 'm 3 5 l 5 3 l 12 10 l 19 3 l 21 5 l 14 12 l 21 19 l 19 21 l 12 14 l 5 21 l 3 19 l 10 12',
  check = 'm 3 12 l 5 10 l 9 14 l 19 4 l 21 6 l 9 18',
}

-- A gear: eight teeth round a ring, the hole wound the other way so it stays open
local function gear()
  local cx, cy, teeth = 12, 12, 8
  local outer, root, hole = 11.5, 8.6, 3.6
  local pts = {}
  for i = 0, teeth - 1 do
    local a = i * 2 * math.pi / teeth
    local half = math.pi / teeth
    for _, p in ipairs({ { a - half * 0.95, root }, { a - half * 0.45, outer }, { a + half * 0.45, outer },
      { a + half * 0.95, root } }) do
      table.insert(pts, string.format('%.2f %.2f', cx + p[2] * math.cos(p[1]), cy + p[2] * math.sin(p[1])))
    end
  end
  local path = 'm ' .. pts[1] .. ' l ' .. table.concat(pts, ' ', 2)
  local ring = {}
  for i = 24, 0, -1 do
    local a = i * 2 * math.pi / 24
    table.insert(ring, string.format('%.2f %.2f', cx + hole * math.cos(a), cy + hole * math.sin(a)))
  end
  return path .. ' m ' .. ring[1] .. ' l ' .. table.concat(ring, ' ', 2)
end
ICONS.gear = gear()

---------------------------------------------------------------------------
-- State
---------------------------------------------------------------------------

local mouse = { x = -1, y = -1 }
local visible = true
local last_activity = mp.get_time()
local hidden_after = 3
local targets = {} -- clickable rects of the last render: {x, y, w, h, fn, id}
local hover_id = nil
local panel = nil -- 'tracks' | 'episodes' | 'volume' | nil
local seeking = false

local function prop(name, default)
  local v = mp.get_property_native(name)
  if v == nil then return default end
  return v
end

local function fmt_time(secs)
  secs = math.max(0, math.floor(secs or 0))
  local hh, mm, ss = math.floor(secs / 3600), math.floor(secs / 60) % 60, secs % 60
  if hh > 0 then return string.format('%d:%02d:%02d', hh, mm, ss) end
  return string.format('%d:%02d', mm, ss)
end

local function inside(x, y, rw, rh)
  return mouse.x >= x and mouse.x <= x + rw and mouse.y >= y and mouse.y <= y + rh
end

-- An area the mouse can click; returns whether it is hovered
local function target(id, x, y, rw, rh, fn)
  table.insert(targets, { x = x, y = y, w = rw, h = rh, fn = fn, id = id })
  return inside(x, y, rw, rh)
end

local function playlist_count() return prop('playlist-count', 0) end
local function playlist_pos() return prop('playlist-pos', 0) end
local function has_next() return not opts.live and playlist_pos() + 1 < playlist_count() end

-- "S2 E5 · Name" (how the app titles episodes) → "S2:E5", "Name"
local function split_title(title)
  local se, name = title:match('^(S%d+ E%d+) · (.*)$')
  if se then return se:gsub(' ', ':'), name end
  return nil, title
end

---------------------------------------------------------------------------
-- Previews
---------------------------------------------------------------------------
-- A provider line often allows one connection, which the player holds, so a
-- frame cannot be fetched from the stream a second time. The player downloads
-- ahead into its cache instead (the app's cache options), and a preview comes
-- from there: `dump-cache` writes a sliver of the cache at the hovered time
-- to a file (instant), and a hidden mpv decodes its first frame, the keyframe
-- at or just before that time, to raw BGRA for `overlay-add`. One request at
-- a time; while one runs, only the newest position waits.

-- Defined under Render (it asks for a redraw); the previews redraw when a frame arrives
local render
local last_drawn = nil

-- `file` is the frame on show: a new name for every frame (never rewritten,
-- so the file MPV has mapped is never truncated under it), only taken once
-- it holds a whole frame. A frame MPV maps past its end crashes the player.
local preview = { file = nil, w = 0, h = 0, t = nil, tried = nil, busy = false, pending = nil, gen = 0,
  shown = nil, old = {} }
preview_wanted = false

-- Names unique to this player (its pid) and to each frame
local pid = tostring(mp.get_property_number('pid', 0))
local function preview_path(name) return utils.join_path(opts.work, 'preview-' .. pid .. '-' .. name) end

function preview_size()
  local tw = math.floor(320 * s / 1.1)
  local dw, dh = prop('dwidth', 16), prop('dheight', 9)
  if dw <= 0 or dh <= 0 then dw, dh = 16, 9 end
  return tw, math.floor(tw * dh / dw / 2) * 2
end

-- Whether `t` is downloaded, in one of the cache's ranges
local function cached(t)
  local state = prop('demuxer-cache-state', {})
  for _, r in ipairs(state['seekable-ranges'] or {}) do
    if t >= (r['start'] or 0) and t <= (r['end'] or 0) - 0.5 then return true end
  end
  return false
end

-- A whole w×h BGRA frame, and nothing less
local function whole_frame(path, w, h)
  local info = utils.file_info(path)
  return info ~= nil and info.is_file and info.size == w * h * 4
end

-- Files of frames no longer shown: deleting one MPV still maps is safe on
-- unlink-style systems, but keep the last two to be sure
local function forget_old(path)
  table.insert(preview.old, path)
  while #preview.old > 2 do os.remove(table.remove(preview.old, 1)) end
end

local function preview_run(t)
  preview.busy, preview.tried = true, t
  local tw, th = preview_size()
  preview.gen = preview.gen + 1
  local out = preview_path(preview.gen .. '.bgra')
  local sliver = preview_path('sliver.mkv')
  local function finish()
    preview.busy = false
    if preview.pending then
      local next_t = preview.pending
      preview.pending = nil
      if next_t ~= preview.tried then preview_run(next_t) end
    end
  end
  mp.command_native_async({ 'dump-cache', tostring(t), tostring(t + 0.1), sliver }, function(ok)
    if not ok then return finish() end
    mp.command_native_async({
      name = 'subprocess',
      playback_only = false,
      capture_stdout = true,
      args = { opts.mpv, '--no-config', '--really-quiet', '--no-terminal', '--load-scripts=no', '--no-audio',
        '--no-sub', '--frames=1', '--hwdec=no', '--vf=scale=' .. tw .. ':' .. th .. ',format=bgra',
        '--of=rawvideo', '--ovc=rawvideo', '--o=' .. out, sliver },
    }, function(done, result)
      -- An exit without a whole frame (a sliver with no keyframe) shows nothing
      if done and result and result.status == 0 and whole_frame(out, tw, th) then
        if preview.file then forget_old(preview.file) end
        preview.file, preview.w, preview.h, preview.t = out, tw, th, t
        render()
      else
        os.remove(out)
      end
      finish()
    end)
  end)
end

-- Ask for the frame at `t` (to the second); false when it is not downloaded
function preview_request(t)
  if opts.work == '' or not cached(t) then return false end
  t = math.floor(t)
  if preview.t ~= t and preview.tried ~= t then
    if preview.busy then preview.pending = t else preview_run(t) end
  end
  return true
end

-- Whether a frame is ready to show
function preview_ready() return preview.file ~= nil end

function preview_show(x, y)
  local file = preview.file
  if not file then return end
  local key = file .. '@' .. x .. ',' .. y
  if preview.shown == key then return end
  -- Checked again right before MPV maps it
  if not whole_frame(file, preview.w, preview.h) then
    preview.file = nil
    return
  end
  mp.command_native({ 'overlay-add', 1, x, y, file, 0, 'bgra', preview.w, preview.h, preview.w * 4 })
  preview.shown = key
end

function preview_hide()
  if preview.shown then
    mp.command_native({ 'overlay-remove', 1 })
    preview.shown = nil
  end
end

local function preview_reset()
  preview_hide()
  if preview.file then forget_old(preview.file) end
  preview.file, preview.t, preview.tried, preview.pending = nil, nil, nil, nil
end
mp.register_event('file-loaded', preview_reset)
mp.register_event('shutdown', function()
  preview_hide()
  for _, path in ipairs(preview.old) do os.remove(path) end
  if preview.file then os.remove(preview.file) end
  os.remove(preview_path('sliver.mkv'))
end)

---------------------------------------------------------------------------
-- Layout
---------------------------------------------------------------------------

local function timeline_geometry()
  local x0, x1 = 88 * s, w - 186 * s
  local y = h - 148 * s
  return x0, x1, y
end

local function draw_gradient(ass, top)
  -- Bands from 70 % black to clear (ASS has no gradients), on whole pixels
  -- so no two overlap: an overlap draws a darker line
  local height = math.floor((top and 220 or 320) * s)
  -- 10 px bands: smooth enough over video, a third of the events to draw
  local bands = math.max(1, math.floor(height / 10))
  local edges = {}
  for i = 0, bands do edges[i] = math.floor(height * i / bands) end
  for i = 0, bands - 1 do
    -- Eased: dark near the edge, fading quickly toward the middle
    local t = (i + 0.5) / bands
    local alpha = string.format('%02X', math.floor(0x4C + (0xFF - 0x4C) * t * t * (3 - 2 * t)))
    local y0, y1 = edges[i], edges[i + 1]
    if top then rect(ass, 0, y0, w, y1 - y0, '000000', alpha)
    else rect(ass, 0, h - y1, w, y1 - y0, '000000', alpha) end
  end
end

local function draw_timeline(ass)
  local x0, x1, y = timeline_geometry()
  local duration = prop('duration', 0)
  local pos = prop('time-pos', 0)
  if duration <= 0 then return end
  local hovered = target('timeline', x0 - 10 * s, y - 24 * s, x1 - x0 + 20 * s, 48 * s, function()
    seeking = true
  end) or seeking
  local thick = (hovered and 10 or 6) * s
  local x0m, x1m = timeline_geometry()
  local frac = math.min(1, math.max(0, pos / duration))
  if seeking and x1m > x0m then
    -- Dragging: follow the mouse now, not the seek MPV is still doing
    frac = math.min(1, math.max(0, (mouse.x - x0m) / (x1m - x0m)))
    pos = frac * duration
  end
  local cache = prop('demuxer-cache-time', 0)
  local buffered = math.min(1, math.max(frac, cache / duration))
  rect(ass, x0, y - thick / 2, x1 - x0, thick, TRACK)
  rect(ass, x0, y - thick / 2, (x1 - x0) * buffered, thick, BUFFERED)
  rect(ass, x0, y - thick / 2, (x1 - x0) * frac, thick, ACCENT)
  circle(ass, x0 + (x1 - x0) * frac, y, (hovered and 18 or 14) * s, ACCENT)
  text(ass, w - 80 * s, y, fmt_time(duration - pos), 30 * s, WHITE, 6)

  -- Preview: the time under the mouse, and the frame there once downloaded
  preview_wanted = false
  if hovered and mouse.x >= x0 and mouse.x <= x1 then
    local t = (mouse.x - x0) / (x1 - x0) * duration
    local tw, th = preview_size()
    local tx = math.floor(math.min(w - tw - 10, math.max(10, mouse.x - tw / 2)))
    local ty = math.floor(y - 40 * s - th)
    if preview_request(t) then
      preview_wanted = true
      rect(ass, tx - 3, ty - 3, tw + 6, th + 6, WHITE, '40')
      if preview_ready() then preview_show(tx, ty) end
      text(ass, mouse.x, ty + th + 6 * s, fmt_time(t), 28 * s, WHITE, 8, true)
    else
      text(ass, mouse.x, y - 34 * s, fmt_time(t), 28 * s, WHITE, 2, true)
    end
  end
end

local last_drag_seek = 0
local function seek_to_mouse(exact)
  -- While dragging, a keyframe seek at most every 80 ms; the release seeks exactly
  if not exact then
    local now = mp.get_time()
    if now - last_drag_seek < 0.08 then return end
    last_drag_seek = now
  end
  local x0, x1 = timeline_geometry()
  local frac = math.min(1, math.max(0, (mouse.x - x0) / (x1 - x0)))
  mp.commandv('seek', tostring(frac * 100), exact and 'absolute-percent+exact' or 'absolute-percent+keyframes')
end

local function button(ass, id, x, cy, size, path, fn, scale_hover)
  local hovered = target(id, x - 8 * s, cy - size / 2 - 8 * s, size + 16 * s, size + 16 * s, fn)
  local k = (hovered and scale_hover ~= false) and 1.2 or 1
  local sz = size * k
  icon(ass, x + size / 2 - sz / 2, cy - sz / 2, sz, path, WHITE)
  return hovered
end

local function draw_volume(ass, x, cy, size)
  local muted = prop('mute', false)
  local volume = prop('volume', 100)
  local hovered = target('volume', x - 8 * s, cy - size / 2 - 8 * s, size + 16 * s, size + 16 * s, function()
    mp.commandv('cycle', 'mute')
  end)
  icon(ass, x, cy - size / 2, size, ICONS.vol, WHITE)
  if muted or volume == 0 then
    icon(ass, x, cy - size / 2, size, ICONS.mute, WHITE)
  else
    icon(ass, x, cy - size / 2, size, ICONS.wave1, WHITE)
    if volume > 50 then icon(ass, x, cy - size / 2, size, ICONS.wave2, WHITE) end
  end
  -- Hovering the speaker opens a slider above it, as long as the mouse stays on either
  local sw, sh = 44 * s, 200 * s
  local sx, sy = x + size / 2 - sw / 2, cy - size / 2 - 24 * s - sh
  if hovered then panel = 'volume' end
  if panel == 'volume' then
    local on_slider = inside(sx - 12 * s, sy, sw + 24 * s, sh + 30 * s)
    if not hovered and not on_slider then
      panel = nil
      return
    end
    rounded(ass, sx, sy, sw, sh, 6 * s, PANEL, '10')
    local bx, by, bh = sx + sw / 2 - 4 * s, sy + 20 * s, sh - 40 * s
    local frac = muted and 0 or math.min(1, volume / 100)
    rect(ass, bx, by, 8 * s, bh, TRACK)
    rect(ass, bx, by + bh * (1 - frac), 8 * s, bh * frac, ACCENT)
    circle(ass, bx + 4 * s, by + bh * (1 - frac), 12 * s, ACCENT)
    target('volume-slider', sx, sy, sw, sh, function() panel = 'volume-drag' end)
  end
end

local function set_volume_from_mouse()
  local size = 48 * s
  local sh = 200 * s
  local cy = h - 70 * s
  local by = cy - size / 2 - 24 * s - sh + 20 * s
  local bh = sh - 40 * s
  local frac = math.min(1, math.max(0, 1 - (mouse.y - by) / bh))
  mp.set_property_number('volume', math.floor(frac * 100 + 0.5))
  mp.set_property_bool('mute', false)
end

local function draw_title(ass, x, cy)
  local title = prop('media-title', '')
  local se, name = split_title(title)
  if opts.live then
    rounded(ass, x, cy - 16 * s, 70 * s, 32 * s, 4 * s, ACCENT)
    text(ass, x + 35 * s, cy, 'LIVE', 20 * s, ON_ACCENT, 5, true)
    text(ass, x + 86 * s, cy, title, 32 * s, WHITE, 4, true)
    return
  end
  if se and opts.series ~= '' then
    -- "Series  S2:E5  Name": the series bold, the rest lighter
    local ass_text = string.format('{\\fn%s\\fs%d\\b1\\1c&H%s&}%s{\\b0\\1c&H%s&}   %s   %s', opts.font, 32 * s,
      WHITE, opts.series, GREY, se, name)
    event(ass, x, cy, WHITE, '00', ass_text, 4)
  elseif se then
    event(ass, x, cy, WHITE, '00', string.format('{\\fn%s\\fs%d\\b1}%s{\\b0\\1c&H%s&}   %s', opts.font,
      32 * s, se, GREY, name), 4)
  else
    text(ass, x, cy, title, 32 * s, WHITE, 4, true)
  end
end

local function track_label(t)
  local parts = {}
  local lang = t.lang and t.lang:upper() or nil
  if t.title and t.title ~= '' then table.insert(parts, t.title) end
  if lang and (not t.title or not t.title:upper():find(lang, 1, true)) then table.insert(parts, lang) end
  if #parts == 0 then table.insert(parts, (t.type == 'sub' and 'Subtitles ' or 'Track ') .. t.id) end
  return table.concat(parts, ' · ')
end

-- A panel of choices in columns above the button at `anchor_x`, open while
-- the mouse is on the button or the panel. `cols`: { title, items }, each
-- item { id, label, selected, fn }.
local function draw_columns_panel(ass, anchor_x, anchor_hovered, cols, colw)
  local row = 52 * s
  colw = (colw or 340) * s
  local rows = 0
  for _, col in ipairs(cols) do rows = math.max(rows, #col[2]) end
  local pw, ph = colw * #cols + 40 * s, 90 * s + rows * row + 20 * s
  local px = math.min(w - pw - 20 * s, anchor_x - pw / 2)
  local py = h - 120 * s - ph
  if not anchor_hovered and not inside(px, py, pw, ph + 40 * s) then
    panel = nil
    return
  end
  rounded(ass, px, py, pw, ph, 6 * s, PANEL)
  for c, col in ipairs(cols) do
    local cx = px + 20 * s + (c - 1) * colw
    text(ass, cx + 30 * s, py + 30 * s, col[1], 34 * s, WHITE, 7, true)
    for i, item in ipairs(col[2]) do
      local ry = py + 80 * s + (i - 1) * row
      local hovered = target(item.id, cx, ry, colw - 10 * s, row, item.fn)
      if item.selected then icon(ass, cx, ry + row / 2 - 12 * s, 24 * s, ICONS.check, WHITE) end
      text(ass, cx + 40 * s, ry + row / 2, item.label, 28 * s, (hovered or item.selected) and WHITE or GREY, 4,
        item.selected)
    end
  end
end

local function subtitle_sizes()
  local scale = prop('sub-scale', 1)
  local sizes = {}
  for _, opt in ipairs({ { 'Small', 0.8 }, { 'Medium', 1 }, { 'Large', 1.3 } }) do
    table.insert(sizes, {
      id = 'subsize-' .. opt[1],
      label = opt[1],
      selected = math.abs(scale - opt[2]) < 0.05,
      fn = function() mp.set_property_number('sub-scale', opt[2]) end,
    })
  end
  return sizes
end

-- A stream's video renditions ("1080p · 5.2 Mb/s"); most streams have one
local function quality_label(t)
  local parts = {}
  local hgt = t['demux-h']
  if hgt then table.insert(parts, hgt .. 'p') end
  local rate = t['hls-bitrate'] or t['demux-bitrate']
  if rate and rate > 0 then table.insert(parts, string.format('%.1f Mb/s', rate / 1e6)) end
  if #parts == 0 then table.insert(parts, t.title or ('Version ' .. t.id)) end
  return table.concat(parts, ' · ')
end

local function draw_tracks_panel(ass, anchor_x, anchor_hovered)
  local choose = function(property, id) return function() mp.set_property(property, tostring(id)) end end
  local sid = prop('sid', false)
  local audio = {}
  local subs = { { id = 'sid-no', label = 'Off', selected = sid == false or sid == 'no', fn = choose('sid', 'no') } }
  for _, t in ipairs(prop('track-list', {})) do
    if t.type == 'audio' then
      table.insert(audio, { id = 'aid-' .. t.id, label = track_label(t), selected = t.selected, fn = choose('aid', t.id) })
    elseif t.type == 'sub' then
      table.insert(subs, { id = 'sid-' .. t.id, label = track_label(t), selected = t.selected, fn = choose('sid', t.id) })
    end
  end
  draw_columns_panel(ass, anchor_x, anchor_hovered,
    { { 'Audio', audio }, { 'Subtitles', subs }, { 'Subtitle size', subtitle_sizes() } }, 300)
end

-- The gear: playback speed, how the picture fills the window, and the
-- stream's quality when it offers more than one (an IPTV stream rarely does;
-- a film's 4K copy is a separate title, chosen in the app)
local function draw_settings_panel(ass, anchor_x, anchor_hovered)
  local speed = prop('speed', 1)
  local speeds = {}
  for _, v in ipairs({ 0.5, 0.75, 1, 1.25, 1.5 }) do
    table.insert(speeds, {
      id = 'speed-' .. v,
      label = v == 1 and 'Normal' or (tostring(v) .. '×'),
      selected = math.abs(speed - v) < 0.01,
      fn = function() mp.set_property_number('speed', v) end,
    })
  end
  local keepaspect = prop('keepaspect', true)
  local panscan = prop('panscan', 0)
  local fit = keepaspect and panscan < 0.5
  local picture = {
    { id = 'pic-fit', label = 'Fit', selected = fit, fn = function()
      mp.set_property_bool('keepaspect', true); mp.set_property_number('panscan', 0)
    end },
    { id = 'pic-fill', label = 'Fill', selected = keepaspect and not fit, fn = function()
      mp.set_property_bool('keepaspect', true); mp.set_property_number('panscan', 1)
    end },
    { id = 'pic-stretch', label = 'Stretch', selected = not keepaspect, fn = function()
      mp.set_property_number('panscan', 0); mp.set_property_bool('keepaspect', false)
    end },
  }
  local cols = { { 'Speed', speeds }, { 'Picture', picture } }
  local qualities = {}
  for _, t in ipairs(prop('track-list', {})) do
    if t.type == 'video' and not t.image and not t.albumart then
      table.insert(qualities, {
        id = 'vid-' .. t.id,
        label = quality_label(t),
        selected = t.selected,
        h = t['demux-h'] or 0,
        fn = function() mp.set_property('vid', tostring(t.id)) end,
      })
    end
  end
  if #qualities > 1 then
    table.sort(qualities, function(a, b) return a.h > b.h end)
    table.insert(cols, { 'Quality', qualities })
  end
  draw_columns_panel(ass, anchor_x, anchor_hovered, cols, 260)
end

local function draw_episodes_panel(ass, anchor_x, anchor_hovered)
  local count = playlist_count()
  local pos = playlist_pos()
  local row = 56 * s
  local shown = math.min(count, 8)
  local first = math.max(0, math.min(pos - 2, count - shown))
  local pw, ph = 620 * s, 80 * s + shown * row + 16 * s
  local px = math.min(w - pw - 20 * s, anchor_x - pw / 2)
  local py = h - 120 * s - ph
  if not anchor_hovered and not inside(px, py, pw, ph + 40 * s) then
    panel = nil
    return
  end
  rounded(ass, px, py, pw, ph, 6 * s, PANEL)
  text(ass, px + 30 * s, py + 26 * s, opts.series ~= '' and opts.series or 'Episodes', 34 * s, WHITE, 7, true)
  for i = 0, shown - 1 do
    local idx = first + i
    local title = prop('playlist/' .. idx .. '/title', '') or ''
    local ry = py + 76 * s + i * row
    local current = idx == pos
    local hovered = target('episode-' .. idx, px + 10 * s, ry, pw - 20 * s, row, function()
      mp.commandv('playlist-play-index', tostring(idx))
    end)
    if current or hovered then rect(ass, px + 10 * s, ry, pw - 20 * s, row, '000000', current and '60' or '90') end
    local se, name = split_title(title)
    text(ass, px + 30 * s, ry + row / 2, (se and (se .. '   ') or '') .. name, 28 * s,
      (current or hovered) and WHITE or GREY, 4, current)
  end
end

local function draw_next_episode_card(ass)
  -- In the last minute of an episode, a button to go on, shown even without the controls
  if not has_next() then return end
  local remaining = prop('time-remaining', 1e9)
  local duration = prop('duration', 0)
  if duration < 300 or remaining > 60 then return end
  local bw, bh = 280 * s, 64 * s
  local bx, by = w - bw - 80 * s, h - (visible and 260 or 120) * s
  local hovered = target('next-card', bx, by, bw, bh, function() mp.command('playlist-next') end)
  rounded(ass, bx, by, bw, bh, 4 * s, hovered and 'E6E6E6' or WHITE)
  icon(ass, bx + 26 * s, by + bh / 2 - 14 * s, 28 * s, ICONS.play, '000000')
  text(ass, bx + 70 * s, by + bh / 2, 'Next Episode', 30 * s, '000000', 4, true)
end

---------------------------------------------------------------------------
-- Render
---------------------------------------------------------------------------

local function draw_now()
  local dims = mp.get_property_native('osd-dimensions')
  if not dims or dims.w == 0 then return end
  w, h = dims.w, dims.h
  s = math.min(w / 1920, h / 1080) * 1.1
  targets = {}
  local ass = assdraw.ass_new()

  if visible then
    draw_gradient(ass, true)
    draw_gradient(ass, false)

    -- Close: the player goes, back to the app
    local close_size = 40 * s
    local cx, cyy = w - 103 * s - close_size / 2, 76 * s
    button(ass, 'close', cx, cyy, close_size, ICONS.close, function() mp.command('quit') end)

    if not opts.live then draw_timeline(ass) end

    local cy, size = h - 70 * s, 48 * s
    local x = 100 * s
    local paused = prop('pause', false)
    button(ass, 'play', x - 12 * s, cy, size, paused and ICONS.play or ICONS.pause, function()
      mp.commandv('cycle', 'pause')
    end)
    x = x + 100 * s
    draw_volume(ass, x - 12 * s, cy, size)
    draw_title(ass, x + 72 * s, cy)

    -- Right side, from the edge inwards
    local rx = w - 103 * s
    button(ass, 'full', rx - size / 2, cy, size, prop('fullscreen', false) and ICONS.unfull or ICONS.full,
      function() mp.commandv('cycle', 'fullscreen') end)
    rx = rx - 116 * s
    local settings_hover = button(ass, 'settings', rx - size / 2, cy, size, ICONS.gear, function()
      panel = panel == 'settings' and nil or 'settings'
    end)
    if settings_hover then panel = 'settings' end
    local settings_x = rx
    rx = rx - 116 * s
    local tracks_hover = button(ass, 'tracks', rx - size / 2, cy, size, ICONS.subs, function()
      panel = panel == 'tracks' and nil or 'tracks'
    end)
    local lk = tracks_hover and 1.2 or 1
    icon(ass, rx - size * lk / 2, cy - size * lk / 2, size * lk, ICONS.subs_lines, '000000')
    if tracks_hover then panel = 'tracks' end
    local tracks_x = rx
    rx = rx - 116 * s
    local episodes_hover, episodes_x = false, rx
    if playlist_count() > 1 then
      episodes_hover = button(ass, 'episodes', rx - size / 2, cy, size, ICONS.episodes, function()
        panel = panel == 'episodes' and nil or 'episodes'
      end)
      if episodes_hover then panel = 'episodes' end
      rx = rx - 116 * s
    end
    if has_next() then
      button(ass, 'next', rx - size / 2, cy, size, ICONS.next, function() mp.command('playlist-next') end)
    end

    if panel == 'tracks' then draw_tracks_panel(ass, tracks_x, tracks_hover) end
    if panel == 'settings' then draw_settings_panel(ass, settings_x, settings_hover) end
    if panel == 'episodes' then draw_episodes_panel(ass, episodes_x, episodes_hover) end
  end

  if not opts.live then draw_next_episode_card(ass) end

  if not (visible and preview_wanted) then preview_hide() end

  -- Unchanged frames are not sent: an overlay update makes MPV redraw the OSD
  local key = w .. 'x' .. h .. ass.text
  if key ~= last_drawn then
    last_drawn = key
    overlay.res_x, overlay.res_y = w, h
    overlay.data = ass.text
    overlay:update()
  end
end

-- Everything asks for a redraw with render(); it happens at most 30 times a
-- second, however fast the mouse moves or properties change
local dirty = true
function render() dirty = true end
mp.add_periodic_timer(1 / 30, function()
  if dirty then
    dirty = false
    draw_now()
  end
end)

---------------------------------------------------------------------------
-- Showing and hiding
---------------------------------------------------------------------------

local function set_visible(v)
  if visible == v then return end
  visible = v
  mp.set_property('cursor-autohide', v and 'no' or 'always')
  if not v then panel = nil end
  render()
end

local function activity()
  last_activity = mp.get_time()
  set_visible(true)
end

-- The clock and the hide-after-idle check: four times a second is enough
mp.add_periodic_timer(0.25, function()
  local idle = mp.get_time() - last_activity > hidden_after
  local over_controls = mouse.y > h - 220 * s or mouse.y < 140 * s
  if visible and idle and not prop('pause', false) and panel == nil and not seeking and not over_controls then
    set_visible(false)
  end
  render()
end)

---------------------------------------------------------------------------
-- Mouse
---------------------------------------------------------------------------

local function hit()
  for i = #targets, 1, -1 do
    local t = targets[i]
    if mouse.x >= t.x and mouse.x <= t.x + t.w and mouse.y >= t.y and mouse.y <= t.y + t.h then return t end
  end
end

mp.observe_property('mouse-pos', 'native', function(_, pos)
  if not pos then return end
  local moved = pos.x ~= mouse.x or pos.y ~= mouse.y
  mouse.x, mouse.y = pos.x, pos.y
  if pos.hover == false then
    mouse.x, mouse.y = -1, -1
    return
  end
  if moved then
    activity()
    if seeking then seek_to_mouse(false) end
    if panel == 'volume-drag' then set_volume_from_mouse() end
  end
  local t = hit()
  hover_id = t and t.id or nil
  -- Redraw now: waiting for the next tick makes hover and scrubbing lag
  if moved then render() end
end)

-- A click on the picture pauses; two in quick succession go fullscreen
local pending_click = nil
mp.add_forced_key_binding('MBTN_LEFT', 'biptv-click', function(e)
  if e.event == 'down' then
    local t = visible and hit() or nil
    if t then
      t.fn()
      if t.id == 'timeline' then seek_to_mouse(false) end
      if t.id == 'volume-slider' then set_volume_from_mouse() end
      activity()
      return
    end
    if pending_click then
      pending_click:kill()
      pending_click = nil
      mp.commandv('cycle', 'fullscreen')
    else
      pending_click = mp.add_timeout(0.25, function()
        pending_click = nil
        mp.commandv('cycle', 'pause')
      end)
    end
    activity()
  elseif e.event == 'up' then
    if seeking then
      seek_to_mouse(true)
      seeking = false
    end
    if panel == 'volume-drag' then panel = 'volume' end
  end
end, { complex = true })
mp.add_forced_key_binding('MBTN_LEFT_DBL', 'biptv-dbl', function() end)
mp.add_forced_key_binding('MOUSE_LEAVE', 'biptv-leave', function()
  mouse.x, mouse.y = -1, -1
  panel = nil
end)

---------------------------------------------------------------------------
-- Keys, as on the streaming services
---------------------------------------------------------------------------

local function key(name, fn) mp.add_forced_key_binding(name, 'biptv-key-' .. name, function() fn(); activity() end) end
if not opts.live then
  key('LEFT', function() mp.commandv('seek', '-10') end)
  key('RIGHT', function() mp.commandv('seek', '10') end)
end
key('UP', function() mp.commandv('add', 'volume', '10') end)
key('DOWN', function() mp.commandv('add', 'volume', '-10') end)
key('SPACE', function() mp.commandv('cycle', 'pause') end)
key('f', function() mp.commandv('cycle', 'fullscreen') end)
key('m', function() mp.commandv('cycle', 'mute') end)

for _, name in ipairs({ 'pause', 'fullscreen', 'mute', 'volume', 'media-title', 'track-list', 'playlist-pos' }) do
  mp.observe_property(name, 'native', function() render() end)
end
mp.observe_property('pause', 'bool', function() activity() end)
mp.register_event('file-loaded', activity)
