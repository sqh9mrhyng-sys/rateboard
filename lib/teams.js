/* Team codes Real uses -> the team names The Odds API uses (2026-11-16, for the
   prediction-market EV page). Pro leagues only; college and soccer come later. */
export const ODDS_TEAMS = {
  nhl: { ANA: 'Anaheim Ducks', BOS: 'Boston Bruins', BUF: 'Buffalo Sabres', CGY: 'Calgary Flames', CAR: 'Carolina Hurricanes', CHI: 'Chicago Blackhawks',
    COL: 'Colorado Avalanche', CBJ: 'Columbus Blue Jackets', DAL: 'Dallas Stars', DET: 'Detroit Red Wings', EDM: 'Edmonton Oilers', FLA: 'Florida Panthers',
    LA: 'Los Angeles Kings', LAK: 'Los Angeles Kings', MIN: 'Minnesota Wild', MTL: 'Montréal Canadiens', NSH: 'Nashville Predators', NJ: 'New Jersey Devils', NJD: 'New Jersey Devils',
    NYI: 'New York Islanders', NYR: 'New York Rangers', OTT: 'Ottawa Senators', PHI: 'Philadelphia Flyers', PIT: 'Pittsburgh Penguins', SJ: 'San Jose Sharks', SJS: 'San Jose Sharks',
    SEA: 'Seattle Kraken', STL: 'St Louis Blues', TB: 'Tampa Bay Lightning', TBL: 'Tampa Bay Lightning', TOR: 'Toronto Maple Leafs', UTA: 'Utah Mammoth', VAN: 'Vancouver Canucks',
    VGK: 'Vegas Golden Knights', WSH: 'Washington Capitals', WPG: 'Winnipeg Jets' },
  nba: { ATL: 'Atlanta Hawks', BOS: 'Boston Celtics', BKN: 'Brooklyn Nets', CHA: 'Charlotte Hornets', CHI: 'Chicago Bulls', CLE: 'Cleveland Cavaliers', DAL: 'Dallas Mavericks',
    DEN: 'Denver Nuggets', DET: 'Detroit Pistons', GS: 'Golden State Warriors', GSW: 'Golden State Warriors', HOU: 'Houston Rockets', IND: 'Indiana Pacers', LAC: 'Los Angeles Clippers',
    LAL: 'Los Angeles Lakers', MEM: 'Memphis Grizzlies', MIA: 'Miami Heat', MIL: 'Milwaukee Bucks', MIN: 'Minnesota Timberwolves', NO: 'New Orleans Pelicans', NOP: 'New Orleans Pelicans',
    NY: 'New York Knicks', NYK: 'New York Knicks', OKC: 'Oklahoma City Thunder', ORL: 'Orlando Magic', PHI: 'Philadelphia 76ers', PHX: 'Phoenix Suns', POR: 'Portland Trail Blazers',
    SAC: 'Sacramento Kings', SA: 'San Antonio Spurs', SAS: 'San Antonio Spurs', TOR: 'Toronto Raptors', UTA: 'Utah Jazz', UTAH: 'Utah Jazz', WAS: 'Washington Wizards', WSH: 'Washington Wizards' },
  nfl: { ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens', BUF: 'Buffalo Bills', CAR: 'Carolina Panthers', CHI: 'Chicago Bears', CIN: 'Cincinnati Bengals',
    CLE: 'Cleveland Browns', DAL: 'Dallas Cowboys', DEN: 'Denver Broncos', DET: 'Detroit Lions', GB: 'Green Bay Packers', HOU: 'Houston Texans', IND: 'Indianapolis Colts',
    JAX: 'Jacksonville Jaguars', KC: 'Kansas City Chiefs', LV: 'Las Vegas Raiders', LAC: 'Los Angeles Chargers', LAR: 'Los Angeles Rams', MIA: 'Miami Dolphins', MIN: 'Minnesota Vikings',
    NE: 'New England Patriots', NO: 'New Orleans Saints', NYG: 'New York Giants', NYJ: 'New York Jets', PHI: 'Philadelphia Eagles', PIT: 'Pittsburgh Steelers', SF: 'San Francisco 49ers',
    SEA: 'Seattle Seahawks', TB: 'Tampa Bay Buccaneers', TEN: 'Tennessee Titans', WAS: 'Washington Commanders', WSH: 'Washington Commanders' },
  /* FC (2026-11-21): Real's club codes that differ from ESPN's (Real "MCI" = ESPN "MNC", 2026-11-21 Fulham @ Man City
     had no fair), plus the Premier League by its usual codes. Names as The Odds API spells them. */
  soccer: { MCI: 'Manchester City', MNC: 'Manchester City', MUN: 'Manchester United', MAN: 'Manchester United', MNU: 'Manchester United', ARS: 'Arsenal', AVL: 'Aston Villa',
    BOU: 'Bournemouth', BRE: 'Brentford', BHA: 'Brighton and Hove Albion', BRI: 'Brighton and Hove Albion', BUR: 'Burnley', CHE: 'Chelsea', COV: 'Coventry City', CRY: 'Crystal Palace',
    EVE: 'Everton', FUL: 'Fulham', IPS: 'Ipswich Town', LEE: 'Leeds United', LEI: 'Leicester City', LIV: 'Liverpool', NEW: 'Newcastle United', NFO: 'Nottingham Forest', NOT: 'Nottingham Forest',
    SOU: 'Southampton', SUN: 'Sunderland', TOT: 'Tottenham Hotspur', WHU: 'West Ham United', WOL: 'Wolverhampton Wanderers', SHU: 'Sheffield United', MID: 'Middlesbrough', WBA: 'West Bromwich Albion' }
};
export const ODDS_SPORT = { nhl: 'icehockey_nhl', nba: 'basketball_nba', nfl: 'americanfootball_nfl', ncaaf: 'americanfootball_ncaaf', ncaam: 'basketball_ncaab', ufc: 'mma_mixed_martial_arts' };
