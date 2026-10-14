/**
 * Automatic annotations. Both are coarse screens that a person still reads.
 *
 * CANNOT_SEE: the reasoning says the quoted messages are not visible, or
 * cannot be told apart. On the prototype's group 0 (38 turns) this matched
 * exactly the six turns known to have that reasoning. On layouts that mark the
 * messages it also matches harmless sentences (for example "X is not in the
 * conversation, it is in the block"), so matches there are read by hand.
 *
 * MARK_LEAK: the reply reads a mark, a block title or its numbering out.
 */
export const CANNOT_SEE_SOURCE =
  "not (actually )?(shown|visible|included|provided|present)|can(no|'|’)t see|cannot see|don'?t see|do not see|no quoted|aren'?t (shown|visible|in the)|not in the conversation|where are the|which (ones|messages) are (the )?quoted|don't have the (content|text)|看不到|没有显示|没看到";
export const CANNOT_SEE = new RegExp(`(${CANNOT_SEE_SOURCE})`, "i");
export const MARK_LEAK =
  /\[Earlier message|\[Note\.|Earlier message\.|They said this on|You replied this on|EARLIER MESSAGES|Reference material|\[\d+\]|written before (that|the|their) correction|较早(的)?消息[。:：\]】]|参考材料|方括号/i;
