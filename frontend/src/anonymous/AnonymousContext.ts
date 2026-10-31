import { createContext, useContext } from 'react'
import type { HeldSession } from './held.ts'

export type AuthForm = 'signin' | 'signup'
/** Where a form was opened from: the summary's prompt, or any other screen. */
export type FormOrigin = 'screen' | 'prompt'

export const SIGNUP_PATH = '/signup'
export const LOGIN_PATH = '/login'

export function pathForForm(form: AuthForm): string {
  return form === 'signup' ? SIGNUP_PATH : LOGIN_PATH
}

/** The form a URL path opens, or null. */
export function formFromPath(path: string): AuthForm | null {
  const clean = path.replace(/\/+$/, '')
  if (clean === SIGNUP_PATH) return 'signup'
  if (clean === LOGIN_PATH) return 'signin'
  return null
}

/** Provided by `AuthGate` while the app runs without an account (#331). */
export interface AnonymousUse {
  /** The finished session this page holds for the summary's prompt. */
  held: HeldSession
  /** Switches to the sign-up or sign-in form in place (a plain click on a link). */
  openForm: (form: AuthForm, origin: FormOrigin) => void
}

export const AnonymousContext = createContext<AnonymousUse | null>(null)

/** Non-null while the app is used without an account. */
export function useAnonymous(): AnonymousUse | null {
  return useContext(AnonymousContext)
}
