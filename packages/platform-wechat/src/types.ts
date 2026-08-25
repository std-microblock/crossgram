export interface ComWeChatResponse {
  msg?: unknown
  data?: unknown
  [key: string]: unknown
}

/** Tolerant representation of the JSON object sent to the ComWeChat TCP callback. */
export interface ComWeChatCallback {
  type?: unknown
  isSendMsg?: unknown
  isSendByPhone?: unknown
  msgid?: unknown
  sender?: unknown
  wxid?: unknown
  message?: unknown
  sign?: unknown
  thumb_path?: unknown
  filepath?: unknown
  extrainfo?: unknown
  time?: unknown
  timestamp?: unknown
  self?: unknown
  [key: string]: unknown
}

export interface ComWeChatContact {
  wxid?: unknown
  id?: unknown
  userName?: unknown
  nickname?: unknown
  nickName?: unknown
  wxNickName?: unknown
  remark?: unknown
  remarkName?: unknown
  wxRemark?: unknown
  [key: string]: unknown
}
