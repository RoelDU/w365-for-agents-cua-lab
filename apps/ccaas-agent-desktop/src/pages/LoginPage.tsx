import { LoginScreen } from "@/components/workflow/LoginScreen";

export function LoginPage() {
  // Microsoft Entra ID is the sole sign-in path; the screen renders the
  // dedicated Microsoft sign-in action.
  return <LoginScreen />;
}
