use crate::error::AppError;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};

// ========== PIN Validation ==========

/// Validate PIN format (4-6 digits, only numbers)
pub fn validate_pin(pin: &str) -> Result<(), AppError> {
    if pin.len() < 4 || pin.len() > 6 {
        return Err(AppError::InvalidInput("PIN must be 4-6 digits".to_string()));
    }
    if !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::InvalidInput(
            "PIN must contain only numbers".to_string(),
        ));
    }
    Ok(())
}

// ========== PIN Hashing ==========

/// Hash a PIN using Argon2 with cryptographically secure salt
pub fn hash_pin(pin: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();

    let password_hash = argon2
        .hash_password(pin.as_bytes(), &salt)
        .map_err(|e| AppError::Config(format!("Failed to hash PIN: {}", e)))?
        .to_string();

    Ok(password_hash)
}

/// Verify a PIN against a stored hash
pub fn verify_pin_hash(pin: &str, hash: &str) -> Result<bool, AppError> {
    let parsed_hash = PasswordHash::new(hash)
        .map_err(|e| AppError::Config(format!("Invalid stored hash: {}", e)))?;

    let argon2 = Argon2::default();
    Ok(argon2.verify_password(pin.as_bytes(), &parsed_hash).is_ok())
}

// ========== Channel Filtering ==========

/// Check if a channel name contains adult content markers
#[allow(dead_code)]
pub fn is_adult_content(channel_name: &str) -> bool {
    let name_lower = channel_name.to_lowercase();
    let adult_keywords = ["+18", "xxx", "adult", "18+", "porn", "sex"];

    adult_keywords
        .iter()
        .any(|keyword| name_lower.contains(keyword))
}

/// Filter channels based on parental control settings
#[allow(dead_code)]
pub fn should_block_channel(
    channel_name: &str,
    channel_category: Option<&str>,
    blocked_categories: &[String],
    auto_detect_enabled: bool,
) -> bool {
    // Check if channel category is blocked
    if let Some(category) = channel_category {
        if blocked_categories.iter().any(|bc| bc == category) {
            return true;
        }
    }

    // Check if auto-detect is enabled and channel contains adult content markers
    if auto_detect_enabled && is_adult_content(channel_name) {
        return true;
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_pin_valid() {
        assert!(validate_pin("1234").is_ok());
        assert!(validate_pin("123456").is_ok());
        assert!(validate_pin("0000").is_ok());
    }

    #[test]
    fn test_validate_pin_invalid_length() {
        assert!(validate_pin("123").is_err()); // Too short
        assert!(validate_pin("1234567").is_err()); // Too long
        assert!(validate_pin("").is_err()); // Empty
    }

    #[test]
    fn test_validate_pin_invalid_characters() {
        assert!(validate_pin("12a4").is_err()); // Contains letter
        assert!(validate_pin("12-4").is_err()); // Contains dash
        assert!(validate_pin("12 4").is_err()); // Contains space
    }

    #[test]
    fn test_hash_and_verify_pin() {
        let pin = "1234";
        let hash = hash_pin(pin).expect("Failed to hash PIN");

        // Correct PIN should verify
        assert!(verify_pin_hash(pin, &hash).expect("Verification failed"));

        // Wrong PIN should not verify
        assert!(!verify_pin_hash("5678", &hash).expect("Verification failed"));
    }

    #[test]
    fn test_is_adult_content() {
        assert!(is_adult_content("XXX Channel"));
        assert!(is_adult_content("Adult Movies"));
        assert!(is_adult_content("Channel +18"));
        assert!(is_adult_content("18+ Content"));
        assert!(is_adult_content("Porn TV"));
        assert!(is_adult_content("Sex Channel"));

        assert!(!is_adult_content("HBO"));
        assert!(!is_adult_content("Discovery Channel"));
        assert!(!is_adult_content("News 24"));
    }

    #[test]
    fn test_should_block_channel_category() {
        let blocked_categories = vec!["Adult".to_string(), "Premium".to_string()];

        assert!(should_block_channel(
            "HBO",
            Some("Adult"),
            &blocked_categories,
            false
        ));
        assert!(should_block_channel(
            "Premium Sports",
            Some("Premium"),
            &blocked_categories,
            false
        ));
        assert!(!should_block_channel(
            "CNN",
            Some("News"),
            &blocked_categories,
            false
        ));
    }

    #[test]
    fn test_should_block_channel_auto_detect() {
        let blocked_categories = vec![];

        assert!(should_block_channel(
            "XXX Channel",
            None,
            &blocked_categories,
            true
        ));
        assert!(!should_block_channel(
            "XXX Channel",
            None,
            &blocked_categories,
            false // Auto-detect disabled
        ));
        assert!(!should_block_channel(
            "HBO",
            None,
            &blocked_categories,
            true
        ));
    }

    #[test]
    fn test_should_block_channel_combined() {
        let blocked_categories = vec!["Adult".to_string()];

        // Both category and auto-detect
        assert!(should_block_channel(
            "XXX Movies",
            Some("Adult"),
            &blocked_categories,
            true
        ));

        // Only category match
        assert!(should_block_channel(
            "Regular Channel",
            Some("Adult"),
            &blocked_categories,
            false
        ));

        // Only auto-detect match
        assert!(should_block_channel(
            "XXX Channel",
            Some("Movies"),
            &blocked_categories,
            true
        ));

        // No match
        assert!(!should_block_channel(
            "HBO",
            Some("Entertainment"),
            &blocked_categories,
            false
        ));
    }
}
