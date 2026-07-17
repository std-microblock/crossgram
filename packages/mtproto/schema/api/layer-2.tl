boolFalse#bc799737 = Bool;
boolTrue#997275b5 = Bool;

true#3fedd339 = True;

vector#1cb5c415 {t:Type} # [ t ] = Vector t;

error#c4b9f9bb code:int text:string = Error;

null#56730bcc = Null;

inputPeerEmpty#7f3b18ea = InputPeer;
inputPeerSelf#7da07ec9 = InputPeer;
inputPeerContact#1023dbe8 user_id:int = InputPeer;
inputPeerForeign#9b447325 user_id:int access_hash:long = InputPeer;
inputPeerChat#179be863 chat_id:int = InputPeer;

inputUserEmpty#b98886cf = InputUser;
inputUserSelf#f7c1b13f = InputUser;
inputUserContact#86e94f65 user_id:int = InputUser;
inputUserForeign#655e74ff user_id:int access_hash:long = InputUser;

inputPhoneContact#f392b7f4 client_id:long phone:string first_name:string last_name:string = InputContact;

inputFile#f52ff27f id:long parts:int name:string md5_checksum:string = InputFile;

inputMediaEmpty#9664f57f = InputMedia;
inputMediaUploadedPhoto#2dc53a7d file:InputFile = InputMedia;
inputMediaPhoto#8f2ab2ec id:InputPhoto = InputMedia;
inputMediaGeoPoint#f9c44144 geo_point:InputGeoPoint = InputMedia;
inputMediaContact#a6e45987 phone_number:string first_name:string last_name:string = InputMedia;
inputMediaUploadedVideo#4847d92a file:InputFile duration:int w:int h:int = InputMedia;
inputMediaUploadedThumbVideo#e628a145 file:InputFile thumb:InputFile duration:int w:int h:int = InputMedia;
inputMediaVideo#7f023ae6 id:InputVideo = InputMedia;

inputChatPhotoEmpty#1ca48f57 = InputChatPhoto;
inputChatUploadedPhoto#94254732 file:InputFile crop:InputPhotoCrop = InputChatPhoto;
inputChatPhoto#b2e1bf08 id:InputPhoto crop:InputPhotoCrop = InputChatPhoto;

inputGeoPointEmpty#e4c123d6 = InputGeoPoint;
inputGeoPoint#f3b7acc9 lat:double long:double = InputGeoPoint;

inputPhotoEmpty#1cd7bf0d = InputPhoto;
inputPhoto#fb95c6c4 id:long access_hash:long = InputPhoto;

inputVideoEmpty#5508ec75 = InputVideo;
inputVideo#ee579652 id:long access_hash:long = InputVideo;

inputFileLocation#14637196 volume_id:long local_id:int secret:long = InputFileLocation;
inputVideoFileLocation#3d0364ec id:long access_hash:long = InputFileLocation;

inputPhotoCropAuto#ade6b004 = InputPhotoCrop;
inputPhotoCrop#d9915325 crop_left:double crop_top:double crop_width:double = InputPhotoCrop;

peerUser#9db1bc6d user_id:int = Peer;
peerChat#bad0e5bb chat_id:int = Peer;

storage.fileUnknown#aa963b05 = storage.FileType;
storage.filePartial#40bc6f52 = storage.FileType;
storage.fileJpeg#7efe0e = storage.FileType;
storage.fileGif#cae1aadf = storage.FileType;
storage.filePng#a4f63c0 = storage.FileType;
storage.filePdf#ae1e508d = storage.FileType;
storage.fileMp3#528a0677 = storage.FileType;
storage.fileMov#4b09ebbc = storage.FileType;
storage.fileMp4#b3cea0e4 = storage.FileType;
storage.fileWebp#1081464c = storage.FileType;

fileLocationUnavailable#7c596b46 volume_id:long local_id:int secret:long = FileLocation;
fileLocation#53d69076 dc_id:int volume_id:long local_id:int secret:long = FileLocation;

userEmpty#200250ba id:int = User;
userSelf#720535ec id:int first_name:string last_name:string phone:string photo:UserProfilePhoto status:UserStatus inactive:Bool = User;
userContact#f2fb8319 id:int first_name:string last_name:string access_hash:long phone:string photo:UserProfilePhoto status:UserStatus = User;
userRequest#22e8ceb0 id:int first_name:string last_name:string access_hash:long phone:string photo:UserProfilePhoto status:UserStatus = User;
userForeign#5214c89d id:int first_name:string last_name:string access_hash:long photo:UserProfilePhoto status:UserStatus = User;
userDeleted#b29ad7cc id:int first_name:string last_name:string = User;

userProfilePhotoEmpty#4f11bae1 = UserProfilePhoto;
userProfilePhoto#d559d8c8 photo_id:long photo_small:FileLocation photo_big:FileLocation = UserProfilePhoto;

userStatusEmpty#9d05049 = UserStatus;
userStatusOnline#edb93949 expires:int = UserStatus;
userStatusOffline#8c703f was_online:int = UserStatus;

chatEmpty#9ba2d800 id:int = Chat;
chat#6e9c9bc7 id:int title:string photo:ChatPhoto participants_count:int date:int left:Bool version:int = Chat;
chatForbidden#fb0ccc41 id:int title:string date:int = Chat;

chatFull#630e61be id:int participants:ChatParticipants chat_photo:Photo notify_settings:PeerNotifySettings = ChatFull;

chatParticipant#c8d7493e user_id:int inviter_id:int date:int = ChatParticipant;

chatParticipantsForbidden#fd2bb8a chat_id:int = ChatParticipants;
chatParticipants#7841b415 chat_id:int admin_id:int participants:Vector<ChatParticipant> version:int = ChatParticipants;

chatPhotoEmpty#37c1011c = ChatPhoto;
chatPhoto#6153276a photo_small:FileLocation photo_big:FileLocation = ChatPhoto;

messageEmpty#83e5de54 id:int = Message;
message#22eb6aba id:int from_id:int to_id:Peer out:Bool unread:Bool date:int message:string media:MessageMedia = Message;
messageForwarded#5f46804 id:int fwd_from_id:int fwd_date:int from_id:int to_id:Peer out:Bool unread:Bool date:int message:string media:MessageMedia = Message;
messageService#9f8d60bb id:int from_id:int to_id:Peer out:Bool unread:Bool date:int action:MessageAction = Message;

messageMediaEmpty#3ded6320 = MessageMedia;
messageMediaPhoto#c8c45a2a photo:Photo = MessageMedia;
messageMediaVideo#a2d24290 video:Video = MessageMedia;
messageMediaGeo#56e0d474 geo:GeoPoint = MessageMedia;
messageMediaContact#5e7d2f39 phone_number:string first_name:string last_name:string user_id:int = MessageMedia;

messageActionEmpty#b6aef7b0 = MessageAction;
messageActionChatCreate#a6638b9a title:string users:Vector<int> = MessageAction;
messageActionChatEditTitle#b5a1ce5a title:string = MessageAction;
messageActionChatEditPhoto#7fcb13a8 photo:Photo = MessageAction;
messageActionChatDeletePhoto#95e3fbef = MessageAction;
messageActionChatAddUser#5e3cfc4b user_id:int = MessageAction;
messageActionChatDeleteUser#b2ae9b0c user_id:int = MessageAction;

dialog#214a8cdf peer:Peer top_message:int unread_count:int = Dialog;

photoEmpty#2331b22d id:long = Photo;
photo#22b56751 id:long access_hash:long user_id:int date:int caption:string geo:GeoPoint sizes:Vector<PhotoSize> = Photo;

photoSizeEmpty#e17e23c type:string = PhotoSize;
photoSize#77bfb61b type:string location:FileLocation w:int h:int size:int = PhotoSize;
photoCachedSize#e9a734fa type:string location:FileLocation w:int h:int bytes:bytes = PhotoSize;

videoEmpty#c10658a8 id:long = Video;
video#5a04a49f id:long access_hash:long user_id:int date:int caption:string duration:int size:int thumb:PhotoSize dc_id:int w:int h:int = Video;

geoPointEmpty#1117dd5f = GeoPoint;
geoPoint#2049d70c long:double lat:double = GeoPoint;

auth.checkedPhone#e300cc3b phone_registered:Bool phone_invited:Bool = auth.CheckedPhone;

auth.sentCode#2215bcbd phone_registered:Bool phone_code_hash:string = auth.SentCode;

auth.authorization#f6b673a4 expires:int user:User = auth.Authorization;

auth.exportedAuthorization#df969c2d id:int bytes:bytes = auth.ExportedAuthorization;

inputNotifyPeer#b8bc5b0c peer:InputPeer = InputNotifyPeer;
inputNotifyUsers#193b4417 = InputNotifyPeer;
inputNotifyChats#4a95e84e = InputNotifyPeer;
inputNotifyAll#a429b886 = InputNotifyPeer;

inputPeerNotifyEventsEmpty#f03064d8 = InputPeerNotifyEvents;
inputPeerNotifyEventsAll#e86a2c74 = InputPeerNotifyEvents;

inputPeerNotifySettings#46a2ce98 mute_until:int sound:string show_previews:Bool events_mask:int = InputPeerNotifySettings;

peerNotifyEventsEmpty#add53cb3 = PeerNotifyEvents;
peerNotifyEventsAll#6d1ded88 = PeerNotifyEvents;

peerNotifySettings#8d5e11ee mute_until:int sound:string show_previews:Bool events_mask:int = PeerNotifySettings;

peerSettings#818426cd flags:# report_spam:flags.0?true = PeerSettings;

wallPaper#ccb03657 id:int title:string sizes:Vector<PhotoSize> color:int = WallPaper;

inputReportReasonSpam#58dbcab8 = ReportReason;
inputReportReasonViolence#1e22c78d = ReportReason;
inputReportReasonPornography#2e59d922 = ReportReason;
inputReportReasonChildAbuse#adf44ee3 = ReportReason;
inputReportReasonOther#e1746d0a text:string = ReportReason;

userFull#771095da user:User link:contacts.Link profile_photo:Photo notify_settings:PeerNotifySettings blocked:Bool real_first_name:string real_last_name:string = UserFull;

contact#f911c994 user_id:int mutual:Bool = Contact;

importedContact#d0028438 user_id:int client_id:long = ImportedContact;

contactBlocked#561bc879 user_id:int date:int = ContactBlocked;

contactStatus#aa77b873 user_id:int expires:int = ContactStatus;

contacts.foreignLinkUnknown#133421f8 = contacts.ForeignLink;
contacts.foreignLinkRequested#a7801f47 has_phone:Bool = contacts.ForeignLink;
contacts.foreignLinkMutual#1bea8ce1 = contacts.ForeignLink;

contacts.myLinkEmpty#d22a1c60 = contacts.MyLink;
contacts.myLinkRequested#6c69efee contact:Bool = contacts.MyLink;
contacts.myLinkContact#c240ebd9 = contacts.MyLink;

contacts.link#eccea3f5 my_link:contacts.MyLink foreign_link:contacts.ForeignLink user:User = contacts.Link;

contacts.contactsNotModified#b74ba9d2 = contacts.Contacts;
contacts.contacts#6f8b8cb2 contacts:Vector<Contact> users:Vector<User> = contacts.Contacts;

contacts.importedContacts#d1cd0a4c imported:Vector<ImportedContact> users:Vector<User> = contacts.ImportedContacts;

contacts.blocked#1c138d15 blocked:Vector<ContactBlocked> users:Vector<User> = contacts.Blocked;
contacts.blockedSlice#900802a1 count:int blocked:Vector<ContactBlocked> users:Vector<User> = contacts.Blocked;

messages.dialogs#15ba6c40 dialogs:Vector<Dialog> messages:Vector<Message> chats:Vector<Chat> users:Vector<User> = messages.Dialogs;
messages.dialogsSlice#71e094f3 count:int dialogs:Vector<Dialog> messages:Vector<Message> chats:Vector<Chat> users:Vector<User> = messages.Dialogs;

messages.messages#8c718e87 messages:Vector<Message> chats:Vector<Chat> users:Vector<User> = messages.Messages;
messages.messagesSlice#b446ae3 count:int messages:Vector<Message> chats:Vector<Chat> users:Vector<User> = messages.Messages;

messages.statedMessages#969478bb messages:Vector<Message> chats:Vector<Chat> users:Vector<User> pts:int seq:int = messages.StatedMessages;

messages.statedMessage#d07ae726 message:Message chats:Vector<Chat> users:Vector<User> pts:int seq:int = messages.StatedMessage;

messages.sentMessage#d1f4d35c id:int date:int pts:int seq:int = messages.SentMessage;

messages.chats#8150cbd8 chats:Vector<Chat> users:Vector<User> = messages.Chats;

messages.chatFull#e5d7d19c full_chat:ChatFull chats:Vector<Chat> users:Vector<User> = messages.ChatFull;

messages.affectedHistory#b7de36f2 pts:int seq:int offset:int = messages.AffectedHistory;

inputMessagesFilterEmpty#57e2f66c = MessagesFilter;
inputMessagesFilterPhotos#9609a51c = MessagesFilter;
inputMessagesFilterVideo#9fc00e65 = MessagesFilter;
inputMessagesFilterPhotoVideo#56e9f0e4 = MessagesFilter;
inputMessagesFilterDocument#9eddf188 = MessagesFilter;
inputMessagesFilterAudio#cfc87522 = MessagesFilter;
inputMessagesFilterAudioDocuments#5afbf764 = MessagesFilter;
inputMessagesFilterUrl#7ef0dd87 = MessagesFilter;
inputMessagesFilterGif#ffc86587 = MessagesFilter;

updateNewMessage#13abdb3 message:Message pts:int = Update;
updateMessageID#4e90bfd6 id:int random_id:long = Update;
updateReadMessages#c6649e31 messages:Vector<int> pts:int = Update;
updateDeleteMessages#a92bfe26 messages:Vector<int> pts:int = Update;
updateUserTyping#6baa8508 user_id:int = Update;
updateChatUserTyping#3c46cfe6 chat_id:int user_id:int = Update;
updateChatParticipants#7761198 participants:ChatParticipants = Update;
updateUserStatus#1bfbd823 user_id:int status:UserStatus = Update;
updateUserName#da22d9ad user_id:int first_name:string last_name:string = Update;
updateUserPhoto#95313b0c user_id:int date:int photo:UserProfilePhoto previous:Bool = Update;
updateContactRegistered#2575bbb9 user_id:int date:int = Update;
updateContactLink#51a48a9a user_id:int my_link:contacts.MyLink foreign_link:contacts.ForeignLink = Update;
updateNewAuthorization#8f06529a auth_key_id:long date:int device:string location:string = Update;

updates.state#a0d9c0c pts:int date:int seq:int unread_count:int = updates.State;

updates.differenceEmpty#5d75a138 date:int seq:int = updates.Difference;
updates.difference#8adb0077 new_messages:Vector<Message> other_updates:Vector<Update> chats:Vector<Chat> users:Vector<User> state:updates.State = updates.Difference;
updates.differenceSlice#c5e839b4 new_messages:Vector<Message> other_updates:Vector<Update> chats:Vector<Chat> users:Vector<User> intermediate_state:updates.State = updates.Difference;

updatesTooLong#e317af7e = Updates;
updateShortMessage#d3f45784 id:int from_id:int message:string pts:int date:int seq:int = Updates;
updateShortChatMessage#2b2fbd4e id:int from_id:int chat_id:int message:string pts:int date:int seq:int = Updates;
updateShort#78d4dec1 update:Update date:int = Updates;
updatesCombined#725b04c3 updates:Vector<Update> users:Vector<User> chats:Vector<Chat> date:int seq_start:int seq:int = Updates;
updates#74ae4240 updates:Vector<Update> users:Vector<User> chats:Vector<Chat> date:int seq:int = Updates;

photos.photos#8dca6aa5 photos:Vector<Photo> users:Vector<User> = photos.Photos;
photos.photosSlice#15051f54 count:int photos:Vector<Photo> users:Vector<User> = photos.Photos;

photos.photo#20212ca8 photo:Photo users:Vector<User> = photos.Photo;

upload.file#96a18d5 type:storage.FileType mtime:int bytes:bytes = upload.File;

dcOption#2ec2a43c id:int hostname:string ip_address:string port:int = DcOption;

config#232d5905 date:int test_mode:Bool this_dc:int dc_options:Vector<DcOption> chat_size_max:int = Config;

nearestDc#8e1a1775 country:string this_dc:int nearest_dc:int = NearestDc;

help.appUpdate#8987f311 id:int critical:Bool url:string text:string = help.AppUpdate;
help.noAppUpdate#c45a6536 = help.AppUpdate;

help.inviteText#18cb9f78 message:string = help.InviteText;

---functions---

invokeAfterMsg#cb9f372d {X:Type} msg_id:long query:!X = X;
invokeAfterMsgs#3dc4b4f0 {X:Type} msg_ids:Vector<long> query:!X = X;
invokeWithLayer2#289dd1f6 {X:Type} query:!X = X;

auth.checkPhone#6fe51dfb phone_number:string = auth.CheckedPhone;
auth.sendCode#d16ff372 phone_number:string sms_type:int api_id:int api_hash:string = auth.SentCode;
auth.signUp#1b067634 phone_number:string phone_code_hash:string phone_code:string first_name:string last_name:string = auth.Authorization;
auth.signIn#bcd51581 phone_number:string phone_code_hash:string phone_code:string = auth.Authorization;
auth.logOut#5717da40 = Bool;
auth.resetAuthorizations#9fab0d1a = Bool;
auth.exportAuthorization#e5bfffcd dc_id:int = auth.ExportedAuthorization;
auth.importAuthorization#e3ef9613 id:int bytes:bytes = auth.Authorization;
auth.bindTempAuthKey#cdd42a05 perm_auth_key_id:long nonce:long expires_at:int encrypted_message:bytes = Bool;

account.registerDevice#a28557ac token_type:int token:string device_model:string system_version:string app_version:string app_sandbox:Bool = Bool;
account.unregisterDevice#65c55b40 token_type:int token:string = Bool;
account.updateNotifySettings#84be5b93 peer:InputNotifyPeer settings:InputPeerNotifySettings = Bool;
account.getNotifySettings#12b3ad31 peer:InputNotifyPeer = PeerNotifySettings;
account.resetNotifySettings#db7e1747 = Bool;
account.updateProfile#f0888d68 first_name:string last_name:string = User;
account.updateStatus#6628562c offline:Bool = Bool;
account.getWallPapers#c04cfac2 = Vector<WallPaper>;
account.reportPeer#ae189d5f peer:InputPeer reason:ReportReason = Bool;

users.getUsers#d91a548 id:Vector<InputUser> = Vector<User>;
users.getFullUser#ca30a5b1 id:InputUser = UserFull;

contacts.getStatuses#c4a353ee = Vector<ContactStatus>;
contacts.getContacts#22c6aa08 hash:string = contacts.Contacts;
contacts.importContacts#da30b32d contacts:Vector<InputContact> replace:Bool = contacts.ImportedContacts;
contacts.deleteContact#8e953744 id:InputUser = contacts.Link;
contacts.deleteContacts#59ab389e id:Vector<InputUser> = Bool;
contacts.deleteByPhones#1013fd9e phones:Vector<string> = Bool;
contacts.block#332b49fc id:InputUser = Bool;
contacts.unblock#e54100bd id:InputUser = Bool;
contacts.getBlocked#f57c350f offset:int limit:int = contacts.Blocked;

messages.getMessages#4222fa74 id:Vector<int> = messages.Messages;
messages.getDialogs#eccf1df6 offset:int max_id:int limit:int = messages.Dialogs;
messages.getHistory#92a1df2f peer:InputPeer offset:int max_id:int limit:int = messages.Messages;
messages.search#7e9f2ab peer:InputPeer q:string filter:MessagesFilter min_date:int max_date:int offset:int max_id:int limit:int = messages.Messages;
messages.readHistory#b04f2510 peer:InputPeer max_id:int offset:int = messages.AffectedHistory;
messages.deleteHistory#f4f8fb61 peer:InputPeer offset:int = messages.AffectedHistory;
messages.deleteMessages#14f2dd0a id:Vector<int> = Vector<int>;
messages.receivedMessages#28abcb68 max_id:int = Vector<int>;
messages.setTyping#719839e9 peer:InputPeer typing:Bool = Bool;
messages.sendMessage#4cde0aab peer:InputPeer message:string random_id:long = messages.SentMessage;
messages.sendMedia#a3c85d76 peer:InputPeer media:InputMedia random_id:long = messages.StatedMessage;
messages.forwardMessages#514cd10f peer:InputPeer id:Vector<int> = messages.StatedMessages;
messages.reportSpam#cf1592db peer:InputPeer = Bool;
messages.hideReportSpam#a8f1709b peer:InputPeer = Bool;
messages.getPeerSettings#3672e09c peer:InputPeer = PeerSettings;
messages.report#bd82b658 peer:InputPeer id:Vector<int> reason:ReportReason = Bool;
messages.getChats#3c6aa187 id:Vector<int> = messages.Chats;
messages.getFullChat#3b831c66 chat_id:int = messages.ChatFull;
messages.editChatTitle#b4bc68b5 chat_id:int title:string = messages.StatedMessage;
messages.editChatPhoto#d881821d chat_id:int photo:InputChatPhoto = messages.StatedMessage;
messages.addChatUser#2ee9ee9e chat_id:int user_id:InputUser fwd_limit:int = messages.StatedMessage;
messages.deleteChatUser#c3c5cd23 chat_id:int user_id:InputUser = messages.StatedMessage;
messages.createChat#419d9aee users:Vector<InputUser> title:string = messages.StatedMessage;

updates.getState#edd4882a = updates.State;
updates.getDifference#5b36855a pts:int date:int = updates.Difference;

photos.updateProfilePhoto#eef579a0 id:InputPhoto crop:InputPhotoCrop = UserProfilePhoto;
photos.uploadProfilePhoto#d50f9c88 file:InputFile caption:string geo_point:InputGeoPoint crop:InputPhotoCrop = photos.Photo;
photos.deletePhotos#87cf7f2f id:Vector<InputPhoto> = Vector<long>;
photos.getUserPhotos#b7ee553c user_id:InputUser offset:int max_id:int limit:int = photos.Photos;

upload.saveFilePart#b304a621 file_id:long file_part:int bytes:bytes = Bool;
upload.getFile#e3a6cfb5 location:InputFileLocation offset:int limit:int = upload.File;

help.getConfig#c4f9186b = Config;
help.getNearestDc#1fb33026 = NearestDc;
help.getAppUpdate#c812ac7e device_model:string system_version:string app_version:string lang_code:string = help.AppUpdate;
help.getInviteText#a4a95186 lang_code:string = help.InviteText;
