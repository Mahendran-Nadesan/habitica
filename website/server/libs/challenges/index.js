// Currently this holds helpers for challenge api, but we should break this up into submodules as it expands
import omit from 'lodash/omit';
import uuid from 'uuid';
import { model as Challenge } from '../../models/challenge';
import {
  model as Group,
  TAVERN_ID,
} from '../../models/group';
import {
  NotFound,
  NotAuthorized,
} from '../errors';

const TASK_KEYS_TO_REMOVE = ['_id', 'completed', 'dateCompleted', 'history', 'id', 'streak', 'createdAt', 'challenge'];

export function addUserJoinChallengeNotification (user) {
  if (user.achievements.joinedChallenge) return;
  user.achievements.joinedChallenge = true;
  user.addNotification('CHALLENGE_JOINED_ACHIEVEMENT');
}

export function getChallengeGroupResponse (group) {
  return {
    _id: group._id,
    name: group.name,
    type: group.type,
    privacy: group.privacy,
  };
}

export async function createChallenge (user, req, res) {
  let groupId = req.body.group;
  let prize = req.body.prize;

  let group = await Group.getGroup({user, groupId, fields: '-chat', mustBeMember: true});
  if (!group) throw new NotFound(res.t('groupNotFound'));
  if (!group.isMember(user)) throw new NotAuthorized(res.t('mustBeGroupMember'));

  if (group.leaderOnly && group.leaderOnly.challenges && group.leader !== user._id) {
    throw new NotAuthorized(res.t('onlyGroupLeaderChal'));
  }

  if (group._id === TAVERN_ID && prize < 1) {
    throw new NotAuthorized(res.t('tavChalsMinPrize'));
  }

  if (prize > 0) {
    let groupBalance = group.balance && group.leader === user._id ? group.balance : 0;
    let prizeCost = prize / 4;

    if (prizeCost > user.balance + groupBalance) {
      throw new NotAuthorized(res.t('cantAfford'));
    }

    if (groupBalance >= prizeCost) {
      // Group pays for all of prize
      group.balance -= prizeCost;
    } else if (groupBalance > 0) {
      // User pays remainder of prize cost after group
      let remainder = prizeCost - group.balance;
      group.balance = 0;
      user.balance -= remainder;
    } else {
      // User pays for all of prize
      user.balance -= prizeCost;
    }
  }

  group.challengeCount += 1;

  if (!req.body.summary) {
    req.body.summary = req.body.name;
  }
  req.body.leader = user._id;
  req.body.official = user.contributor.admin && req.body.official ? true : false;
  let challenge = new Challenge(Challenge.sanitize(req.body));

  // First validate challenge so we don't save group if it's invalid (only runs sync validators)
  let challengeValidationErrors = challenge.validateSync();
  if (challengeValidationErrors) throw challengeValidationErrors;

  addUserJoinChallengeNotification(user);

  let results = await Promise.all([challenge.save({
    validateBeforeSave: false, // already validate
  }), group.save()]);
  let savedChal = results[0];

  await savedChal.syncToUser(user); // (it also saves the user)

  return {savedChal, group};
}

export function cleanUpTask (task) {
  let cleansedTask = omit(task, TASK_KEYS_TO_REMOVE);

  // Copy checklists but reset to uncomplete and assign new id
  if (!cleansedTask.checklist) cleansedTask.checklist = [];
  cleansedTask.checklist.forEach((item) => {
    item.completed = false;
    item.id = uuid();
  });

  if (cleansedTask.type !== 'reward') {
    delete cleansedTask.value;
  }

  return cleansedTask;
}
