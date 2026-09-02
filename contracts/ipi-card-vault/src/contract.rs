#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;
use cosmwasm_std::{
    to_json_binary, BankMsg, Binary, Coin, Deps, DepsMut, Env, MessageInfo, Order, Response,
    StdResult, Uint128,
};
use cw2::set_contract_version;
use cw_storage_plus::Bound;

use crate::error::ContractError;
use crate::msg::{
    ConfigResponse, ExecuteMsg, InstantiateMsg, InvitationResponse, InvitationView,
    InvitationsResponse, MemberResponse, MemberView, MembersResponse, QueryMsg,
};
use crate::state::{Invitation, Member, INVITATIONS, MEMBERS, MEMBER_COUNT};

const CONTRACT_NAME: &str = "crates.io:ipi-card-vault";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");
const IPI_DENOM: &str = "aipi";
const DEFAULT_PAGE_LIMIT: u32 = 30;
const MAX_PAGE_LIMIT: u32 = 100;

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    ensure_only_ipi_funds(&info)?;
    let label = validate_label(msg.label)?;
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    MEMBERS.save(
        deps.storage,
        &info.sender,
        &Member {
            label,
            invited_by: None,
            joined_at: env.block.time.seconds(),
        },
    )?;
    MEMBER_COUNT.save(deps.storage, &1)?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("first_card", info.sender))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    if !info.funds.is_empty() {
        return Err(ContractError::FundsNotAccepted);
    }
    match msg {
        ExecuteMsg::InviteCard { address, label } => {
            execute_invite(deps, env, info, address, label)
        }
        ExecuteMsg::AcceptInvitation {} => execute_accept(deps, env, info),
        ExecuteMsg::CancelInvitation { address } => execute_cancel(deps, info, address),
        ExecuteMsg::RemoveCard { address } => execute_remove(deps, info, address),
        ExecuteMsg::Transfer { recipient, amount } => {
            execute_transfer(deps, info, recipient, amount)
        }
    }
}

fn execute_invite(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    address: String,
    label: Option<String>,
) -> Result<Response, ContractError> {
    ensure_member(deps.as_ref(), &info.sender)?;
    let invited = deps.api.addr_validate(&address)?;
    if MEMBERS.has(deps.storage, &invited) {
        return Err(ContractError::AlreadyMember);
    }
    if INVITATIONS.has(deps.storage, &invited) {
        return Err(ContractError::InvitationAlreadyExists);
    }
    INVITATIONS.save(
        deps.storage,
        &invited,
        &Invitation {
            label: validate_label(label)?,
            invited_by: info.sender.clone(),
            created_at: env.block.time.seconds(),
        },
    )?;

    Ok(Response::new()
        .add_attribute("action", "invite_card")
        .add_attribute("invited_card", invited)
        .add_attribute("invited_by", info.sender))
}

fn execute_accept(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    if MEMBERS.has(deps.storage, &info.sender) {
        return Err(ContractError::AlreadyMember);
    }
    let invitation = INVITATIONS
        .may_load(deps.storage, &info.sender)?
        .ok_or(ContractError::InvitationNotFound)?;
    if !MEMBERS.has(deps.storage, &invitation.invited_by) {
        return Err(ContractError::InviterNoLongerActive);
    }
    MEMBERS.save(
        deps.storage,
        &info.sender,
        &Member {
            label: invitation.label,
            invited_by: Some(invitation.invited_by.clone()),
            joined_at: env.block.time.seconds(),
        },
    )?;
    MEMBER_COUNT.update(deps.storage, |count| -> StdResult<_> { Ok(count + 1) })?;
    INVITATIONS.remove(deps.storage, &info.sender);

    Ok(Response::new()
        .add_attribute("action", "accept_invitation")
        .add_attribute("card", info.sender)
        .add_attribute("invited_by", invitation.invited_by))
}

fn execute_cancel(
    deps: DepsMut,
    info: MessageInfo,
    address: String,
) -> Result<Response, ContractError> {
    ensure_member(deps.as_ref(), &info.sender)?;
    let invited = deps.api.addr_validate(&address)?;
    if !INVITATIONS.has(deps.storage, &invited) {
        return Err(ContractError::InvitationNotFound);
    }
    INVITATIONS.remove(deps.storage, &invited);
    Ok(Response::new()
        .add_attribute("action", "cancel_invitation")
        .add_attribute("card", invited)
        .add_attribute("cancelled_by", info.sender))
}

fn execute_remove(
    deps: DepsMut,
    info: MessageInfo,
    address: String,
) -> Result<Response, ContractError> {
    ensure_member(deps.as_ref(), &info.sender)?;
    let removed = deps.api.addr_validate(&address)?;
    if !MEMBERS.has(deps.storage, &removed) {
        return Err(ContractError::MemberNotFound);
    }
    let count = MEMBER_COUNT.load(deps.storage)?;
    if count <= 1 {
        return Err(ContractError::LastMember);
    }
    MEMBERS.remove(deps.storage, &removed);
    MEMBER_COUNT.save(deps.storage, &(count - 1))?;
    Ok(Response::new()
        .add_attribute("action", "remove_card")
        .add_attribute("card", removed)
        .add_attribute("removed_by", info.sender))
}

fn execute_transfer(
    deps: DepsMut,
    info: MessageInfo,
    recipient: String,
    amount: Uint128,
) -> Result<Response, ContractError> {
    ensure_member(deps.as_ref(), &info.sender)?;
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount);
    }
    let recipient = deps.api.addr_validate(&recipient)?;
    let transfer = BankMsg::Send {
        to_address: recipient.to_string(),
        amount: vec![Coin::new(amount, IPI_DENOM)],
    };
    Ok(Response::new()
        .add_message(transfer)
        .add_attribute("action", "transfer")
        .add_attribute("authorized_by", info.sender)
        .add_attribute("recipient", recipient)
        .add_attribute("amount", amount))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&query_config(deps)?),
        QueryMsg::Member { address } => to_json_binary(&query_member(deps, address)?),
        QueryMsg::Members { start_after, limit } => {
            to_json_binary(&query_members(deps, start_after, limit)?)
        }
        QueryMsg::Invitation { address } => to_json_binary(&query_invitation(deps, address)?),
        QueryMsg::Invitations { start_after, limit } => {
            to_json_binary(&query_invitations(deps, start_after, limit)?)
        }
    }
}

fn query_config(deps: Deps) -> StdResult<ConfigResponse> {
    Ok(ConfigResponse {
        denom: IPI_DENOM.to_owned(),
        member_count: MEMBER_COUNT.load(deps.storage)?,
    })
}

fn query_member(deps: Deps, address: String) -> StdResult<MemberResponse> {
    let address = deps.api.addr_validate(&address)?;
    let member = MEMBERS
        .may_load(deps.storage, &address)?
        .map(|member| member_view(address, member));
    Ok(MemberResponse { member })
}

fn query_members(
    deps: Deps,
    start_after: Option<String>,
    limit: Option<u32>,
) -> StdResult<MembersResponse> {
    let start = start_after
        .map(|address| deps.api.addr_validate(&address))
        .transpose()?;
    let limit = limit.unwrap_or(DEFAULT_PAGE_LIMIT).min(MAX_PAGE_LIMIT) as usize;
    let members = MEMBERS
        .range(
            deps.storage,
            start.as_ref().map(Bound::exclusive),
            None,
            Order::Ascending,
        )
        .take(limit)
        .map(|item| item.map(|(address, member)| member_view(address, member)))
        .collect::<StdResult<Vec<_>>>()?;
    Ok(MembersResponse { members })
}

fn query_invitation(deps: Deps, address: String) -> StdResult<InvitationResponse> {
    let address = deps.api.addr_validate(&address)?;
    let invitation = INVITATIONS
        .may_load(deps.storage, &address)?
        .map(|invitation| invitation_view(deps, address, invitation))
        .transpose()?;
    Ok(InvitationResponse { invitation })
}

fn query_invitations(
    deps: Deps,
    start_after: Option<String>,
    limit: Option<u32>,
) -> StdResult<InvitationsResponse> {
    let start = start_after
        .map(|address| deps.api.addr_validate(&address))
        .transpose()?;
    let limit = limit.unwrap_or(DEFAULT_PAGE_LIMIT).min(MAX_PAGE_LIMIT) as usize;
    let invitations = INVITATIONS
        .range(
            deps.storage,
            start.as_ref().map(Bound::exclusive),
            None,
            Order::Ascending,
        )
        .take(limit)
        .map(|item| {
            item.and_then(|(address, invitation)| invitation_view(deps, address, invitation))
        })
        .collect::<StdResult<Vec<_>>>()?;
    Ok(InvitationsResponse { invitations })
}

fn member_view(address: cosmwasm_std::Addr, member: Member) -> MemberView {
    MemberView {
        address: address.to_string(),
        label: member.label,
        invited_by: member.invited_by.map(|address| address.to_string()),
        joined_at: member.joined_at,
    }
}

fn invitation_view(
    deps: Deps,
    address: cosmwasm_std::Addr,
    invitation: Invitation,
) -> StdResult<InvitationView> {
    Ok(InvitationView {
        address: address.to_string(),
        label: invitation.label,
        inviter_is_active: MEMBERS.has(deps.storage, &invitation.invited_by),
        invited_by: invitation.invited_by.to_string(),
        created_at: invitation.created_at,
    })
}

fn ensure_member(deps: Deps, address: &cosmwasm_std::Addr) -> Result<(), ContractError> {
    if !MEMBERS.has(deps.storage, address) {
        return Err(ContractError::Unauthorized);
    }
    Ok(())
}

fn ensure_only_ipi_funds(info: &MessageInfo) -> Result<(), ContractError> {
    if info.funds.iter().any(|coin| coin.denom != IPI_DENOM) {
        return Err(ContractError::FundsNotAccepted);
    }
    Ok(())
}

fn validate_label(label: Option<String>) -> Result<Option<String>, ContractError> {
    let Some(label) = label else {
        return Ok(None);
    };
    let normalized = label.trim();
    let length = normalized.chars().count();
    if !(1..=64).contains(&length) || normalized.chars().any(char::is_control) {
        return Err(ContractError::InvalidLabel);
    }
    Ok(Some(normalized.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env, MockApi};
    use cosmwasm_std::{from_json, Addr, CosmosMsg, MessageInfo};

    fn test_address(label: &str) -> Addr {
        MockApi::default().addr_make(label)
    }

    fn test_info(label: &str) -> MessageInfo {
        message_info(&test_address(label), &[])
    }

    fn initialize(deps: DepsMut) {
        instantiate(
            deps,
            mock_env(),
            test_info("first"),
            InstantiateMsg {
                label: Some("First card".to_owned()),
            },
        )
        .unwrap();
    }

    fn invite_and_accept(
        deps: &mut cosmwasm_std::OwnedDeps<
            cosmwasm_std::MemoryStorage,
            cosmwasm_std::testing::MockApi,
            cosmwasm_std::testing::MockQuerier,
        >,
        inviter: &str,
        invited: &str,
    ) {
        execute(
            deps.as_mut(),
            mock_env(),
            test_info(inviter),
            ExecuteMsg::InviteCard {
                address: test_address(invited).to_string(),
                label: Some(format!("{invited} card")),
            },
        )
        .unwrap();
        execute(
            deps.as_mut(),
            mock_env(),
            test_info(invited),
            ExecuteMsg::AcceptInvitation {},
        )
        .unwrap();
    }

    #[test]
    fn invitation_rights_propagate_to_every_accepted_card() {
        let mut deps = mock_dependencies();
        initialize(deps.as_mut());
        invite_and_accept(&mut deps, "first", "second");
        invite_and_accept(&mut deps, "second", "third");
        invite_and_accept(&mut deps, "third", "fourth");

        let config: ConfigResponse =
            from_json(query(deps.as_ref(), mock_env(), QueryMsg::Config {}).unwrap()).unwrap();
        assert_eq!(config.member_count, 4);

        let fourth: MemberResponse = from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::Member {
                    address: test_address("fourth").to_string(),
                },
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            fourth.member.unwrap().invited_by,
            Some(test_address("third").to_string())
        );
    }

    #[test]
    fn invitation_requires_an_active_inviter_and_invited_sender() {
        let mut deps = mock_dependencies();
        initialize(deps.as_mut());
        let unauthorized = execute(
            deps.as_mut(),
            mock_env(),
            test_info("stranger"),
            ExecuteMsg::InviteCard {
                address: test_address("second").to_string(),
                label: None,
            },
        );
        assert_eq!(unauthorized.unwrap_err(), ContractError::Unauthorized);

        execute(
            deps.as_mut(),
            mock_env(),
            test_info("first"),
            ExecuteMsg::InviteCard {
                address: test_address("second").to_string(),
                label: None,
            },
        )
        .unwrap();
        let wrong_sender = execute(
            deps.as_mut(),
            mock_env(),
            test_info("third"),
            ExecuteMsg::AcceptInvitation {},
        );
        assert_eq!(wrong_sender.unwrap_err(), ContractError::InvitationNotFound);
    }

    #[test]
    fn removed_inviter_cannot_activate_an_outstanding_invitation() {
        let mut deps = mock_dependencies();
        initialize(deps.as_mut());
        invite_and_accept(&mut deps, "first", "second");
        execute(
            deps.as_mut(),
            mock_env(),
            test_info("second"),
            ExecuteMsg::InviteCard {
                address: test_address("third").to_string(),
                label: None,
            },
        )
        .unwrap();
        execute(
            deps.as_mut(),
            mock_env(),
            test_info("first"),
            ExecuteMsg::RemoveCard {
                address: test_address("second").to_string(),
            },
        )
        .unwrap();
        let result = execute(
            deps.as_mut(),
            mock_env(),
            test_info("third"),
            ExecuteMsg::AcceptInvitation {},
        );
        assert_eq!(result.unwrap_err(), ContractError::InviterNoLongerActive);
    }

    #[test]
    fn any_member_can_transfer_but_a_non_member_cannot() {
        let mut deps = mock_dependencies();
        initialize(deps.as_mut());
        invite_and_accept(&mut deps, "first", "second");
        let response = execute(
            deps.as_mut(),
            mock_env(),
            test_info("second"),
            ExecuteMsg::Transfer {
                recipient: test_address("recipient").to_string(),
                amount: Uint128::new(42),
            },
        )
        .unwrap();
        assert_eq!(response.messages.len(), 1);
        assert_eq!(
            response.messages[0].msg,
            CosmosMsg::Bank(BankMsg::Send {
                to_address: test_address("recipient").to_string(),
                amount: vec![Coin::new(42u128, IPI_DENOM)],
            })
        );

        let unauthorized = execute(
            deps.as_mut(),
            mock_env(),
            test_info("stranger"),
            ExecuteMsg::Transfer {
                recipient: test_address("recipient").to_string(),
                amount: Uint128::new(1),
            },
        );
        assert_eq!(unauthorized.unwrap_err(), ContractError::Unauthorized);
    }

    #[test]
    fn vault_never_allows_the_last_card_to_be_removed() {
        let mut deps = mock_dependencies();
        initialize(deps.as_mut());
        let result = execute(
            deps.as_mut(),
            mock_env(),
            test_info("first"),
            ExecuteMsg::RemoveCard {
                address: test_address("first").to_string(),
            },
        );
        assert_eq!(result.unwrap_err(), ContractError::LastMember);
    }

    #[test]
    fn any_active_member_can_cancel_an_invitation() {
        let mut deps = mock_dependencies();
        initialize(deps.as_mut());
        invite_and_accept(&mut deps, "first", "second");
        execute(
            deps.as_mut(),
            mock_env(),
            test_info("first"),
            ExecuteMsg::InviteCard {
                address: test_address("third").to_string(),
                label: None,
            },
        )
        .unwrap();
        execute(
            deps.as_mut(),
            mock_env(),
            test_info("second"),
            ExecuteMsg::CancelInvitation {
                address: test_address("third").to_string(),
            },
        )
        .unwrap();

        let invitation: InvitationResponse = from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::Invitation {
                    address: test_address("third").to_string(),
                },
            )
            .unwrap(),
        )
        .unwrap();
        assert!(invitation.invitation.is_none());
    }

    #[test]
    fn removing_a_card_updates_membership_and_count() {
        let mut deps = mock_dependencies();
        initialize(deps.as_mut());
        invite_and_accept(&mut deps, "first", "second");
        execute(
            deps.as_mut(),
            mock_env(),
            test_info("first"),
            ExecuteMsg::RemoveCard {
                address: test_address("second").to_string(),
            },
        )
        .unwrap();

        let removed: MemberResponse = from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::Member {
                    address: test_address("second").to_string(),
                },
            )
            .unwrap(),
        )
        .unwrap();
        let config: ConfigResponse =
            from_json(query(deps.as_ref(), mock_env(), QueryMsg::Config {}).unwrap()).unwrap();
        assert!(removed.member.is_none());
        assert_eq!(config.member_count, 1);
    }
}
