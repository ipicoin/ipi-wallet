use cosmwasm_schema::cw_serde;
use cosmwasm_std::Addr;
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct Member {
    pub label: Option<String>,
    pub invited_by: Option<Addr>,
    pub joined_at: u64,
}

#[cw_serde]
pub struct Invitation {
    pub label: Option<String>,
    pub invited_by: Addr,
    pub created_at: u64,
}

pub const MEMBER_COUNT: Item<u64> = Item::new("member_count");
pub const MEMBERS: Map<&Addr, Member> = Map::new("members");
pub const INVITATIONS: Map<&Addr, Invitation> = Map::new("invitations");
