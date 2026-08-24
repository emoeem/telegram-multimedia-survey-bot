import { describe, expect, it } from "vitest";
import {
  createSurveyParticipantToken,
  verifySurveyParticipantToken,
} from "../../../src/services/participant-session.service";

const SECRET = "test-secret";

describe("survey participant session service", () => {
  it("issues and verifies participant tokens carrying the telegram user id", async () => {
    const token = await createSurveyParticipantToken(SECRET, 42);
    expect(await verifySurveyParticipantToken(SECRET, token)).toBe(42);
  });

  it("rejects tokens signed with a different secret", async () => {
    const token = await createSurveyParticipantToken(SECRET, 42);
    expect(await verifySurveyParticipantToken("other-secret", token)).toBeNull();
  });

  it("rejects tampered tokens", async () => {
    const token = await createSurveyParticipantToken(SECRET, 42);
    const [payload] = token.split(".");
    expect(await verifySurveyParticipantToken(SECRET, `${payload}.AAAA`)).toBeNull();
  });

  it("rejects malformed and expired tokens", async () => {
    expect(await verifySurveyParticipantToken(SECRET, "garbage")).toBeNull();
    const expired = `eyJ1Ijo0MiwgImV4cCI6MSwgInAiOiJwYXJ0aWNpcGFudCJ9.invalid`;
    expect(await verifySurveyParticipantToken(SECRET, expired)).toBeNull();
  });
});
