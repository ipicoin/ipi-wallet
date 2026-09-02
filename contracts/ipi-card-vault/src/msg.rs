use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::Uint128;

#[cw_serde]
pub struct InstantiateMsg {
    pub label: Option<String>,
}

#[cw_serde]
pub enum ExecuteMsg {
    InviteCard {
        address: String,
        label: Option<String>,
    },
    AcceptInvitation {},
    CancelInvitation {
        address: String,
    },
    RemoveCard {
        address: String,
    },
    Transfer {
        recipient: String,
        amount: Uint128,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ConfigResponse)]
    Config {},
    #[returns(MemberResponse)]
    Member { address: String },
    #[returns(MembersResponse)]
    Members {
        start_after: Option<String>,
        limit: Option<u32>,
    },
    #[returns(InvitationResponse)]
    Invitation { address: String },
    #[returns(InvitationsResponse)]
    Invitations {
        start_after: Option<String>,
        limit: Option<u32>,
    },
}

#[cw_serde]
pub struct ConfigResponse {
    pub denom: String,
    pub member_count: u64,
}

#[cw_serde]
pub struct MemberView {
    pub address: String,
    pub label: Option<String>,
    pub invited_by: Option<String>,
    pub joined_at: u64,
}

#[cw_serde]
pub struct MemberResponse {
    pub member: Option<MemberView>,
}

#[cw_serde]
pub struct MembersResponse {
    pub members: Vec<MemberView>,
}

#[cw_serde]
pub struct InvitationView {
    pub address: String,
    pub label: Option<String>,
    pub invited_by: String,
    pub created_at: u64,
    pub inviter_is_active: bool,
}

#[cw_serde]
pub struct InvitationResponse {
    pub invitation: Option<InvitationView>,
}

#[cw_serde]
pub struct InvitationsResponse {
    pub invitations: Vec<InvitationView>,
}
