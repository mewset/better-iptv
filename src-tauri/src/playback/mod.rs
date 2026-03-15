pub mod mpv;

use crate::db::models::Channel;
use crate::state::CurrentChannel;
use crate::error::AppError;
use tokio::sync::RwLock;

/// Play a channel with playback options
pub async fn play_channel(
    mpv: &mut mpv::MpvPlayer,
    current: &RwLock<Option<CurrentChannel>>,
    channel: &Channel,
    options: &mpv::MpvPlaybackOptions<'_>,
) -> Result<(), AppError> {
    mpv.play_stream(&channel.url, options)
        .map_err(|e| AppError::Mpv(e.to_string()))?;

    // Update current channel
    let mut curr = current.write().await;
    *curr = Some(CurrentChannel::from_channel(channel));

    Ok(())
}

/// Stop playback and clear current channel
pub async fn stop(
    mpv: &mut mpv::MpvPlayer,
    current: &RwLock<Option<CurrentChannel>>,
) -> Result<(), AppError> {
    mpv.stop().map_err(|e| AppError::Mpv(e.to_string()))?;

    // Clear current channel
    let mut curr = current.write().await;
    *curr = None;

    Ok(())
}

/// Check if MPV is currently playing
pub fn is_playing(mpv: &mut mpv::MpvPlayer) -> bool {
    mpv.is_playing()
}

/// Check if MPV is installed on the system
pub fn check_mpv_installed() -> bool {
    mpv::MpvPlayer::check_installed()
}
