import { AppRoute } from './routing.const';

export class Routing {

  public static getRoute(route: AppRoute, params?: { [key: string]: string }): string {
    let result = route;
    if (params) {
      Object.keys(params).forEach((key) => {
        result = result.replace(`:${key}`, params[key]) as AppRoute;
      });
    }
    return result;
  }

}