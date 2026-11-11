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
}
