use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("only an active card can perform this action")]
    Unauthorized,

    #[error("attached funds are not accepted for this action")]
    FundsNotAccepted,

    #[error("card is already active")]
    AlreadyMember,

    #[error("an invitation for this card already exists")]
    InvitationAlreadyExists,

    #[error("no invitation exists for this card")]
    InvitationNotFound,

    #[error("the inviting card is no longer active")]
    InviterNoLongerActive,

    #[error("card is not active")]
    MemberNotFound,

    #[error("the final active card cannot be removed")]
    LastMember,

    #[error("amount must be greater than zero")]
    ZeroAmount,

    #[error("card label must contain 1 to 64 visible characters")]
    InvalidLabel,
}
