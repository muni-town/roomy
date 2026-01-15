export {
  getProfile,
  createProfileResolver,
  type Profile,
} from "./profiles";

export {
  resolveDidFromHandle,
  parseIdentifier,
  createHandleResolver,
} from "./handles";

export {
  createStreamHandleRecord,
  removeStreamHandleRecord,
  uploadBlob,
  getPersonalStreamId,
  savePersonalStreamId,
  type StreamHandleConfig,
  type PersonalStreamRecordConfig,
} from "./records";
