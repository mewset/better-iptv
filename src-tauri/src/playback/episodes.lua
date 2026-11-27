-- Better IPTV: a series' queued episodes in the player.
--
-- The app hands mpv a playlist file of the queued episodes, each with its
-- title ("S2 E5 · Name"), which the player's title and episode list show.
-- This script resumes the first episode, removes the playlist file (it holds
-- the provider login) once mpv has read it, and binds N / Shift+N to the next
-- and previous episode. The "Next Episode" button in an episode's last
-- minute is the controls' (player.lua).
local options = require 'mp.options'

local opts = { playlist = '', start = 0 }
options.read_options(opts, 'biptv')

local removed = false
local function forget_playlist()
  if not removed and opts.playlist ~= '' then
    os.remove(opts.playlist)
    removed = true
  end
end

local first = true
mp.register_event('file-loaded', function()
  forget_playlist()
  if first then
    first = false
    local start = tonumber(opts.start) or 0
    if start > 0 then mp.commandv('seek', tostring(start), 'absolute') end
  end
end)
mp.register_event('end-file', function(event)
  -- The playlist itself ends with a redirect once expanded
  if event.reason ~= 'redirect' then forget_playlist() end
end)

mp.add_forced_key_binding('n', 'biptv-next-episode', function() mp.command('playlist-next') end)
mp.add_forced_key_binding('N', 'biptv-previous-episode', function() mp.command('playlist-prev') end)
