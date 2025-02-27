/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import Boom from '@hapi/boom';
import type from 'type-detect';

import type { KibanaRequest } from '@kbn/core/server';

import {
  AUTH_PROVIDER_HINT_QUERY_STRING_PARAMETER,
  AUTH_URL_HASH_QUERY_STRING_PARAMETER,
  NEXT_URL_QUERY_STRING_PARAMETER,
} from '../../../common/constants';
import type { AuthenticationInfo } from '../../elasticsearch';
import { getDetailedErrorMessage } from '../../errors';
import { AuthenticationResult } from '../authentication_result';
import { canRedirectRequest } from '../can_redirect_request';
import { DeauthenticationResult } from '../deauthentication_result';
import { HTTPAuthorizationHeader } from '../http_authentication';
import type { RefreshTokenResult, TokenPair } from '../tokens';
import { Tokens } from '../tokens';
import type { AuthenticationProviderOptions, AuthenticationProviderSpecificOptions } from './base';
import { BaseAuthenticationProvider } from './base';

/**
 * Describes possible OpenID Connect login flows.
 */
export enum OIDCLogin {
  LoginInitiatedByUser = 'login-by-user',
  LoginWithImplicitFlow = 'login-implicit',
  LoginWithAuthorizationCodeFlow = 'login-authorization-code',
  LoginInitiatedBy3rdParty = 'login-initiated-by-3rd-party',
}

/**
 * Describes the parameters that are required by the provider to process the initial login request.
 */
export type ProviderLoginAttempt =
  | { type: OIDCLogin.LoginInitiatedByUser; redirectURL: string }
  | {
      type: OIDCLogin.LoginWithImplicitFlow | OIDCLogin.LoginWithAuthorizationCodeFlow;
      authenticationResponseURI: string;
    }
  | { type: OIDCLogin.LoginInitiatedBy3rdParty; iss: string; loginHint?: string };

/**
 * The state supported by the provider (for the OpenID Connect handshake or established session).
 */
interface ProviderState extends Partial<TokenPair> {
  /**
   * Unique identifier of the OpenID Connect request initiated the handshake used to mitigate
   * replay attacks.
   */
  nonce?: string;

  /**
   * Unique identifier of the OpenID Connect request initiated the handshake used to mitigate
   * CSRF.
   */
  state?: string;

  /**
   * URL to redirect user to after successful OpenID Connect handshake.
   */
  redirectURL?: string;

  /**
   * The name of the OpenID Connect realm that was used to establish session.
   */
  realm: string;
}

/**
 * Checks whether current request can initiate new session.
 * @param request Request instance.
 */
function canStartNewSession(request: KibanaRequest) {
  // We should try to establish new session only if request requires authentication and client
  // can be redirected to the Identity Provider where they can authenticate.
  return canRedirectRequest(request) && request.route.options.authRequired === true;
}

/**
 * Provider that supports authentication using an OpenID Connect realm in Elasticsearch.
 */
export class OIDCAuthenticationProvider extends BaseAuthenticationProvider {
  /**
   * Type of the provider.
   */
  static readonly type = 'oidc';

  /**
   * Specifies Elasticsearch OIDC realm name that Kibana should use.
   */
  private readonly realm: string;

  constructor(
    protected readonly options: Readonly<AuthenticationProviderOptions>,
    oidcOptions?: Readonly<AuthenticationProviderSpecificOptions>
  ) {
    super(options);
    if (!oidcOptions || !oidcOptions.realm) {
      throw new Error('Realm name must be specified');
    }

    if (type(oidcOptions.realm) !== 'string') {
      throw new Error('Realm must be a string');
    }

    this.realm = oidcOptions.realm as string;
  }

  /**
   * Performs OpenID Connect request authentication.
   * @param request Request instance.
   * @param attempt Login attempt description.
   * @param [state] Optional state object associated with the provider.
   */
  public async login(
    request: KibanaRequest,
    attempt: ProviderLoginAttempt,
    state?: ProviderState | null
  ) {
    this.logger.debug('Trying to perform a login.');

    // It may happen that Kibana is re-configured to use different realm for the same provider name,
    // we should clear such session an log user out.
    if (state?.realm && state.realm !== this.realm) {
      const message = `State based on realm "${state.realm}", but provider with the name "${this.options.name}" is configured to use realm "${this.realm}".`;
      this.logger.debug(message);
      return AuthenticationResult.failed(Boom.unauthorized(message));
    }

    if (attempt.type === OIDCLogin.LoginInitiatedBy3rdParty) {
      this.logger.debug('Login has been initiated by a Third Party.');
      // We might already have a state and nonce generated by Elasticsearch (from an unfinished authentication in
      // another tab)
      const oidcPrepareParams = attempt.loginHint
        ? { iss: attempt.iss, login_hint: attempt.loginHint }
        : { iss: attempt.iss };
      return this.initiateOIDCAuthentication(
        request,
        oidcPrepareParams,
        `${this.options.basePath.serverBasePath}/`
      );
    }

    if (attempt.type === OIDCLogin.LoginInitiatedByUser) {
      this.logger.debug(`Login has been initiated by a user.`);
      return this.initiateOIDCAuthentication(request, { realm: this.realm }, attempt.redirectURL);
    }

    if (attempt.type === OIDCLogin.LoginWithImplicitFlow) {
      this.logger.debug('OpenID Connect Implicit Authentication flow is used.');
    } else {
      this.logger.debug('OpenID Connect Authorization Code Authentication flow is used.');
    }

    return await this.loginWithAuthenticationResponse(
      request,
      attempt.authenticationResponseURI,
      state
    );
  }

  /**
   * Performs OpenID Connect request authentication.
   * @param request Request instance.
   * @param [state] Optional state object associated with the provider.
   */
  public async authenticate(request: KibanaRequest, state?: ProviderState | null) {
    this.logger.debug(
      `Trying to authenticate user request to ${request.url.pathname}${request.url.search}.`
    );

    if (HTTPAuthorizationHeader.parseFromRequest(request) != null) {
      this.logger.debug('Cannot authenticate requests with `Authorization` header.');
      return AuthenticationResult.notHandled();
    }

    // It may happen that Kibana is re-configured to use different realm for the same provider name,
    // we should clear such session an log user out.
    if (state?.realm && state.realm !== this.realm) {
      const message = `State based on realm "${state.realm}", but provider with the name "${this.options.name}" is configured to use realm "${this.realm}".`;
      this.logger.debug(message);
      return AuthenticationResult.failed(Boom.unauthorized(message));
    }

    let authenticationResult = AuthenticationResult.notHandled();
    if (state) {
      authenticationResult = await this.authenticateViaState(request, state);
      if (
        authenticationResult.failed() &&
        Tokens.isAccessTokenExpiredError(authenticationResult.error)
      ) {
        authenticationResult = await this.authenticateViaRefreshToken(request, state);
      }
    }

    // If we couldn't authenticate by means of all methods above, let's try to
    // initiate an OpenID Connect based authentication, otherwise just return the authentication result we have.
    // We might already have a state and nonce generated by Elasticsearch (from an unfinished authentication in
    // another tab)
    return authenticationResult.notHandled() && canStartNewSession(request)
      ? await this.initiateAuthenticationHandshake(request)
      : authenticationResult;
  }

  /**
   * Attempts to handle a request that might be a third party initiated OpenID connect authentication attempt or the
   * OpenID Connect Provider redirecting back the UA after an authentication success/failure. In the former case which
   * is signified by the existence of an iss parameter (either in the query of a GET request or the body of a POST
   * request) it attempts to start the authentication flow by calling initiateOIDCAuthentication.
   *
   * In the latter case, it attempts to exchange the authentication response to an elasticsearch access token, passing
   * along to Elasticsearch the state and nonce parameters from the user's session.
   *
   * When login succeeds the elasticsearch access token and refresh token are stored in the state and user is redirected
   * to the URL that was requested before authentication flow started or to default Kibana location in case of a third
   * party initiated login
   * @param request Request instance.
   * @param authenticationResponseURI This URI contains the authentication response returned from the OP and may contain
   * authorization code that es will exchange for an ID Token in case of Authorization Code authentication flow. Or
   * id/access tokens in case of Implicit authentication flow. Elasticsearch will do all the required validation and
   * parsing for both successful and failed responses.
   * @param [sessionState] Optional state object associated with the provider.
   */
  private async loginWithAuthenticationResponse(
    request: KibanaRequest,
    authenticationResponseURI: string,
    sessionState?: ProviderState | null
  ) {
    // If it is an authentication response and the users' session state doesn't contain all the necessary information,
    // then something unexpected happened and we should fail because Elasticsearch won't be able to validate the
    // response.
    const {
      nonce: stateNonce = '',
      state: stateOIDCState = '',
      redirectURL: stateRedirectURL = '',
    } = sessionState || {};
    if (!stateNonce || !stateOIDCState || !stateRedirectURL) {
      const message =
        'Response session state does not have corresponding state or nonce parameters or redirect URL.';
      this.logger.debug(message);
      return AuthenticationResult.failed(Boom.badRequest(message));
    }

    // We have all the necessary parameters, so attempt to complete the OpenID Connect Authentication
    let result: { access_token: string; refresh_token: string; authentication: AuthenticationInfo };
    try {
      // This operation should be performed on behalf of the user with a privilege that normal
      // user usually doesn't have `cluster:admin/xpack/security/oidc/authenticate`.
      // We can replace generic `transport.request` with a dedicated API method call once
      // https://github.com/elastic/elasticsearch/issues/67189 is resolved.
      result = (await this.options.client.asInternalUser.transport.request({
        method: 'POST',
        path: '/_security/oidc/authenticate',
        body: {
          state: stateOIDCState,
          nonce: stateNonce,
          redirect_uri: authenticationResponseURI,
          realm: this.realm,
        },
      })) as any;
    } catch (err) {
      this.logger.debug(
        `Failed to authenticate request via OpenID Connect: ${getDetailedErrorMessage(err)}`
      );
      return AuthenticationResult.failed(err);
    }

    this.logger.debug('Login has been performed with OpenID Connect response.');
    return AuthenticationResult.redirectTo(stateRedirectURL, {
      state: {
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        realm: this.realm,
      },
      user: this.authenticationInfoToAuthenticatedUser(result.authentication),
    });
  }

  /**
   * Initiates an authentication attempt by either providing the realm name or the issuer to Elasticsearch
   *
   * @param request Request instance.
   * @param params OIDC authentication parameters.
   * @param redirectURL URL user is supposed to be redirected to after successful login.
   */
  private async initiateOIDCAuthentication(
    request: KibanaRequest,
    params: { realm: string } | { iss: string; login_hint?: string },
    redirectURL: string
  ) {
    this.logger.debug('Trying to initiate OpenID Connect authentication.');

    try {
      // This operation should be performed on behalf of the user with a privilege that normal
      // user usually doesn't have `cluster:admin/xpack/security/oidc/prepare`.
      // We can replace generic `transport.request` with a dedicated API method call once
      // https://github.com/elastic/elasticsearch/issues/67189 is resolved.
      const { state, nonce, redirect } =
        (await this.options.client.asInternalUser.transport.request({
          method: 'POST',
          path: '/_security/oidc/prepare',
          body: params,
        })) as any;

      this.logger.debug('Redirecting to OpenID Connect Provider with authentication request.');
      return AuthenticationResult.redirectTo(
        redirect,
        // Store the state and nonce parameters in the session state of the user
        { state: { state, nonce, redirectURL, realm: this.realm } }
      );
    } catch (err) {
      this.logger.debug(
        `Failed to initiate OpenID Connect authentication: ${getDetailedErrorMessage(err)}`
      );
      return AuthenticationResult.failed(err);
    }
  }

  /**
   * Tries to extract an elasticsearch access token from state and adds it to the request before it's
   * forwarded to Elasticsearch backend.
   * @param request Request instance.
   * @param state State value previously stored by the provider.
   */
  private async authenticateViaState(request: KibanaRequest, { accessToken }: ProviderState) {
    this.logger.debug('Trying to authenticate via state.');

    if (!accessToken) {
      this.logger.debug('Elasticsearch access token is not found in state.');
      return AuthenticationResult.notHandled();
    }

    try {
      const authHeaders = {
        authorization: new HTTPAuthorizationHeader('Bearer', accessToken).toString(),
      };
      const user = await this.getUser(request, authHeaders);

      this.logger.debug('Request has been authenticated via state.');
      return AuthenticationResult.succeeded(user, { authHeaders });
    } catch (err) {
      this.logger.debug(
        `Failed to authenticate request via state: ${getDetailedErrorMessage(err)}`
      );
      return AuthenticationResult.failed(err);
    }
  }

  /**
   * This method is only called when authentication via an elasticsearch access token stored in the state failed because
   * of expired token. So we should use the elasticsearch refresh token, that is also stored in the state, to extend
   * expired elasticsearch access token and authenticate user with it.
   * @param request Request instance.
   * @param state State value previously stored by the provider.
   */
  private async authenticateViaRefreshToken(request: KibanaRequest, state: ProviderState) {
    this.logger.debug('Trying to refresh elasticsearch access token.');

    if (!state.refreshToken) {
      this.logger.debug('Refresh token is not found in state.');
      return AuthenticationResult.notHandled();
    }

    let refreshTokenResult: RefreshTokenResult | null;
    try {
      refreshTokenResult = await this.options.tokens.refresh(state.refreshToken);
    } catch (err) {
      return AuthenticationResult.failed(err);
    }

    // When user has neither valid access nor refresh token, the only way to resolve this issue is to redirect
    // user to OpenID Connect provider, re-initiate the authentication flow and get a new access/refresh token
    // pair as result. Obviously we can't do that for AJAX requests, so we just reply with `400` and clear error
    // message. There are two reasons for `400` and not `401`: Elasticsearch search responds with `400` so it
    // seems logical to do the same on Kibana side and `401` would force user to logout and do full SLO if it's
    // supported.
    if (refreshTokenResult === null) {
      if (canStartNewSession(request)) {
        this.logger.debug(
          'Both elasticsearch access and refresh tokens are expired. Re-initiating OpenID Connect authentication.'
        );
        return this.initiateAuthenticationHandshake(request);
      }

      return AuthenticationResult.failed(
        Boom.badRequest('Both access and refresh tokens are expired.')
      );
    }

    this.logger.debug('Request has been authenticated via refreshed token.');
    const { accessToken, refreshToken, authenticationInfo } = refreshTokenResult;
    return AuthenticationResult.succeeded(
      this.authenticationInfoToAuthenticatedUser(authenticationInfo),
      {
        authHeaders: {
          authorization: new HTTPAuthorizationHeader('Bearer', accessToken).toString(),
        },
        state: { accessToken, refreshToken, realm: this.realm },
      }
    );
  }

  /**
   * Invalidates an elasticsearch access token and refresh token that were originally created as a successful response
   * to an OpenID Connect based authentication. This does not handle OP initiated Single Logout
   * @param request Request instance.
   * @param state State value previously stored by the provider.
   */
  public async logout(request: KibanaRequest, state?: ProviderState | null) {
    this.logger.debug(`Trying to log user out via ${request.url.pathname}${request.url.search}.`);

    // Having a `null` state means that provider was specifically called to do a logout, but when
    // session isn't defined then provider is just being probed whether or not it can perform logout.
    if (state === undefined) {
      this.logger.debug('There is no elasticsearch access token to invalidate.');
      return DeauthenticationResult.notHandled();
    }

    if (state?.accessToken) {
      try {
        // This operation should be performed on behalf of the user with a privilege that normal
        // user usually doesn't have `cluster:admin/xpack/security/oidc/logout`.
        // We can replace generic `transport.request` with a dedicated API method call once
        // https://github.com/elastic/elasticsearch/issues/67189 is resolved.
        const { redirect } = (await this.options.client.asInternalUser.transport.request({
          method: 'POST',
          path: '/_security/oidc/logout',
          body: { token: state.accessToken, refresh_token: state.refreshToken },
        })) as any;

        this.logger.debug('User session has been successfully invalidated.');

        // Having non-null `redirect` field within logout response means that the OpenID Connect realm configuration
        // supports RP initiated Single Logout and we should redirect user to the specified location in the OpenID Connect
        // Provider to properly complete logout.
        if (redirect != null) {
          this.logger.debug('Redirecting user to the OpenID Connect Provider to complete logout.');
          return DeauthenticationResult.redirectTo(redirect);
        }
      } catch (err) {
        this.logger.debug(`Failed to deauthenticate user: ${getDetailedErrorMessage(err)}`);
        return DeauthenticationResult.failed(err);
      }
    }

    return DeauthenticationResult.redirectTo(this.options.urls.loggedOut(request));
  }

  /**
   * Returns HTTP authentication scheme (`Bearer`) that's used within `Authorization` HTTP header
   * that provider attaches to all successfully authenticated requests to Elasticsearch.
   */
  public getHTTPAuthenticationScheme() {
    return 'bearer';
  }

  /**
   * Tries to initiate OIDC authentication handshake. If the request already includes user URL hash fragment, we will
   * initiate handshake right away, otherwise we'll redirect user to a dedicated page where we capture URL hash fragment
   * first and only then initiate SAML handshake.
   * @param request Request instance.
   */
  private initiateAuthenticationHandshake(request: KibanaRequest) {
    const originalURLHash = request.url.searchParams.get(AUTH_URL_HASH_QUERY_STRING_PARAMETER);
    if (originalURLHash != null) {
      return this.initiateOIDCAuthentication(
        request,
        { realm: this.realm },
        `${this.options.getRequestOriginalURL(request)}${originalURLHash}`
      );
    }

    return AuthenticationResult.redirectTo(
      `${
        this.options.basePath.serverBasePath
      }/internal/security/capture-url?${NEXT_URL_QUERY_STRING_PARAMETER}=${encodeURIComponent(
        this.options.getRequestOriginalURL(request, [
          [AUTH_PROVIDER_HINT_QUERY_STRING_PARAMETER, this.options.name],
        ])
      )}`,
      // Here we indicate that current session, if any, should be invalidated. It is a no-op for the
      // initial handshake, but is essential when both access and refresh tokens are expired.
      { state: null }
    );
  }
}
